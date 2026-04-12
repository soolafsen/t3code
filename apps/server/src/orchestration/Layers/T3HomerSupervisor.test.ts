import type { ProviderRuntimeEvent, ProviderSession, ServerSettings } from "@t3tools/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  T3_HOMER_ACTIVITY_KINDS,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import {
  type ProviderServiceShape,
  ProviderService,
} from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { T3HomerSupervisor } from "../Services/T3HomerSupervisor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { T3HomerSupervisorLive } from "./T3HomerSupervisor.ts";

const asProjectId = (value: string) => ProjectId.make(value);
const asThreadId = (value: string) => ThreadId.make(value);
const asTurnId = (value: string) => TurnId.make(value);
const asMessageId = (value: string) => MessageId.make(value);
const asEventId = (value: string) => EventId.make(value);
const HOMER_ACTIVITY_KIND_SET = new Set<string>(Object.values(T3_HOMER_ACTIVITY_KINDS));

function makeTestServerSettingsLayer(overrides: Partial<ServerSettings> = {}) {
  return ServerSettingsService.layerTest(overrides);
}

function createProviderHarness() {
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  let startedCount = 0;
  let stoppedCount = 0;
  const startedSessions: ProviderSession[] = [];

  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;

  const service: ProviderServiceShape = {
    startSession: (threadId, input) =>
      Effect.sync(() => {
        startedCount += 1;
        const now = new Date().toISOString();
        const session: ProviderSession = {
          provider: input.provider ?? "codex",
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          threadId,
          createdAt: now,
          updatedAt: now,
        };
        startedSessions.push(session);
        return session;
      }),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () =>
      Effect.sync(() => {
        stoppedCount += 1;
      }),
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    rollbackConversation: () => unsupported(),
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  return {
    service,
    emit: (event: ProviderRuntimeEvent) => {
      Effect.runSync(PubSub.publish(runtimeEventPubSub, event));
    },
    counts: () => ({
      startedCount,
      stoppedCount,
      startedSessions: [...startedSessions],
    }),
  };
}

async function waitForThread(
  engine: OrchestrationEngineShape,
  predicate: (thread: NonNullable<Awaited<ReturnType<typeof readThread>>>) => boolean,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;

  async function poll(): Promise<NonNullable<Awaited<ReturnType<typeof readThread>>>> {
    const thread = await readThread(engine);
    if (thread && predicate(thread)) {
      return thread;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for Homer thread state");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  }

  return poll();
}

async function readThread(engine: OrchestrationEngineShape) {
  const readModel = await Effect.runPromise(engine.getReadModel());
  return readModel.threads.find((entry) => entry.id === asThreadId("thread-1")) ?? null;
}

describe("T3HomerSupervisor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | T3HomerSupervisor,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  async function createHarness(options?: { homerEnabled?: boolean }) {
    const provider = createProviderHarness();
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolverLive),
      Layer.provide(SqlitePersistenceMemory),
    );

    const layer = T3HomerSupervisorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(
        makeTestServerSettingsLayer({
          homer: {
            enabled: options?.homerEnabled ?? true,
          },
        }),
      ),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const supervisor = await runtime.runPromise(Effect.service(T3HomerSupervisor));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(supervisor.start().pipe(Scope.provide(scope)));

    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-homer-project"),
        projectId: asProjectId("project-1"),
        title: "Homer Project",
        workspaceRoot: process.cwd(),
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-homer-thread"),
        threadId: asThreadId("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Homer Thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-homer-session"),
        threadId: asThreadId("thread-1"),
        session: {
          threadId: asThreadId("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    return {
      engine,
      provider,
      supervisor,
    };
  }

  it("prepares a handoff and restarts the session after a turn completes", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-1");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-homer-turn-start"),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: asMessageId("msg-homer-user"),
          role: "user",
          text: "Keep pushing on the same task",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: new Date().toISOString(),
      }),
    );

    harness.provider.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-homer-usage"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId,
      payload: {
        usage: {
          usedTokens: 83_000,
          maxTokens: 100_000,
        },
      },
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: asEventId("evt-homer-turn-complete"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId,
      payload: {
        state: "completed",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.activities.some(
          (activity) => activity.kind === T3_HOMER_ACTIVITY_KINDS.sessionStarted,
        ) && candidate.session?.status === "ready",
    );

    const activityKinds = thread.activities.map((activity) => activity.kind);
    expect(activityKinds).toContain(T3_HOMER_ACTIVITY_KINDS.supervising);
    expect(activityKinds).toContain(T3_HOMER_ACTIVITY_KINDS.prepareHandoff);
    expect(activityKinds).toContain(T3_HOMER_ACTIVITY_KINDS.sessionEnded);
    expect(activityKinds).toContain(T3_HOMER_ACTIVITY_KINDS.handoffPrepared);
    expect(activityKinds).toContain(T3_HOMER_ACTIVITY_KINDS.sessionStarted);
    expect(harness.provider.counts().stoppedCount).toBe(1);
    expect(harness.provider.counts().startedCount).toBe(1);
  });

  it("interrupts and restarts immediately after provider compaction", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-1");

    harness.provider.emit({
      type: "thread.state.changed",
      eventId: asEventId("evt-homer-compacted"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId,
      payload: {
        state: "compacted",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.activities.some(
          (activity) => activity.kind === T3_HOMER_ACTIVITY_KINDS.sessionInterrupted,
        ) &&
        candidate.activities.some(
          (activity) => activity.kind === T3_HOMER_ACTIVITY_KINDS.sessionStarted,
        ),
    );

    const activityKinds = thread.activities.map((activity) => activity.kind);
    expect(activityKinds).toContain(T3_HOMER_ACTIVITY_KINDS.sessionInterrupted);
    expect(activityKinds).toContain(T3_HOMER_ACTIVITY_KINDS.sessionStarted);
    expect(harness.provider.counts().stoppedCount).toBe(1);
    expect(harness.provider.counts().startedCount).toBe(1);
  });

  it("stays inert when Homer is disabled", async () => {
    const harness = await createHarness({ homerEnabled: false });

    harness.provider.emit({
      type: "runtime.error",
      eventId: asEventId("evt-homer-disabled-error"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: {
        message: "should be ignored",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    const thread = await readThread(harness.engine);
    expect(thread?.activities.some((activity) => HOMER_ACTIVITY_KIND_SET.has(activity.kind))).toBe(
      false,
    );
    expect(harness.provider.counts().startedCount).toBe(0);
    expect(harness.provider.counts().stoppedCount).toBe(0);
  });

  it("supports a manual force-handoff trigger for dev testing", async () => {
    const harness = await createHarness();

    const result = await Effect.runPromise(
      harness.supervisor.forceHandoff({
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        reason: "Manual Homer test requested from the dev UI.",
      }),
    );

    expect(result).toBe("triggered");

    const thread = await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.activities.some(
          (activity) => activity.kind === T3_HOMER_ACTIVITY_KINDS.sessionStarted,
        ) && candidate.session?.status === "ready",
    );

    const activityKinds = thread.activities.map((activity) => activity.kind);
    expect(activityKinds).toContain(T3_HOMER_ACTIVITY_KINDS.supervising);
    expect(activityKinds).toContain(T3_HOMER_ACTIVITY_KINDS.sessionEnded);
    expect(activityKinds).toContain(T3_HOMER_ACTIVITY_KINDS.handoffPrepared);
    expect(activityKinds).toContain(T3_HOMER_ACTIVITY_KINDS.sessionStarted);
    expect(harness.provider.counts().stoppedCount).toBe(1);
    expect(harness.provider.counts().startedCount).toBe(1);
  });
});
