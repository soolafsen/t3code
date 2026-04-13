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

import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
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
  return readThreadById(engine, asThreadId("thread-1"));
}

async function readThreadById(engine: OrchestrationEngineShape, threadId: ThreadId) {
  const readModel = await Effect.runPromise(engine.getReadModel());
  return readModel.threads.find((entry) => entry.id === threadId) ?? null;
}

async function waitForThreadById(
  engine: OrchestrationEngineShape,
  threadId: ThreadId,
  predicate: (thread: NonNullable<Awaited<ReturnType<typeof readThreadById>>>) => boolean,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;

  async function poll(): Promise<NonNullable<Awaited<ReturnType<typeof readThreadById>>>> {
    const thread = await readThreadById(engine, threadId);
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

async function readThreads(engine: OrchestrationEngineShape) {
  const readModel = await Effect.runPromise(engine.getReadModel());
  return readModel.threads;
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
            statsResetAt: null,
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
        homerSourceThreadId: null,
        homerSuccessorThreadId: null,
        homerTransitionKind: null,
        homerTaskAnchor: null,
        homerManagedWorkState: null,
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
        ) &&
        candidate.session?.status === "ready" &&
        candidate.messages.some(
          (message) =>
            message.role === "user" && message.text.includes("T3 Homer managed-work continuation."),
        ),
    );

    const activityKinds = thread.activities.map((activity) => activity.kind);
    const continuationPrompt =
      thread.messages.find(
        (message) =>
          message.role === "user" && message.text.includes("T3 Homer managed-work continuation."),
      )?.text ?? null;
    expect(activityKinds).toContain(T3_HOMER_ACTIVITY_KINDS.supervising);
    expect(activityKinds).toContain(T3_HOMER_ACTIVITY_KINDS.prepareHandoff);
    expect(activityKinds).toContain(T3_HOMER_ACTIVITY_KINDS.sessionEnded);
    expect(activityKinds).toContain(T3_HOMER_ACTIVITY_KINDS.handoffPrepared);
    expect(activityKinds).toContain(T3_HOMER_ACTIVITY_KINDS.sessionStarted);
    expect(continuationPrompt).toContain("Execution policy: restart_in_place");
    expect(continuationPrompt).toContain("Managed follow-up kind: resume_managed_work");
    expect(continuationPrompt).toContain("Automatic continuation after fresh-session handoff.");
    expect(continuationPrompt).toContain("Execution directives:");
    expect(harness.provider.counts().stoppedCount).toBe(1);
    expect(harness.provider.counts().startedCount).toBe(1);
  });

  it("ignores soft usage/warning handoff triggers while managed work is already active", async () => {
    const harness = await createHarness();

    await Effect.runPromise(
      harness.supervisor.forceHandoff({
        threadId: asThreadId("thread-1"),
        createdAt: "2026-04-13T09:00:00.000Z",
        reason: "Start managed recovery once.",
      }),
    );

    await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.homerManagedWorkState?.status === "active" &&
        candidate.session?.status === "ready" &&
        harness.provider.counts().startedCount === 1,
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: asEventId("evt-homer-soft-turn-started"),
      provider: "codex",
      createdAt: "2026-04-13T09:00:01.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-soft-usage-managed"),
      payload: {
        model: "gpt-5-codex",
      },
    });

    harness.provider.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-homer-soft-usage-managed"),
      provider: "codex",
      createdAt: "2026-04-13T09:00:05.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-soft-usage-managed"),
      payload: {
        usage: {
          usedTokens: 90_000,
          maxTokens: 100_000,
        },
      },
    });

    harness.provider.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-homer-soft-warning-managed"),
      provider: "codex",
      createdAt: "2026-04-13T09:00:06.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-soft-usage-managed"),
      payload: {
        message: "Context usage is high.",
      },
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: asEventId("evt-homer-soft-managed-complete"),
      provider: "codex",
      createdAt: "2026-04-13T09:00:07.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-soft-usage-managed"),
      payload: {
        state: "completed",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    const thread = await readThread(harness.engine);

    expect(thread?.session?.status).toBe("ready");
    expect(thread?.homerManagedWorkState?.status).toBe("active");
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
    expect(activityKinds).toContain(T3_HOMER_ACTIVITY_KINDS.sessionInterrupted);
    expect(activityKinds).toContain(T3_HOMER_ACTIVITY_KINDS.handoffPrepared);
    expect(activityKinds).toContain(T3_HOMER_ACTIVITY_KINDS.sessionStarted);
    expect(harness.provider.counts().stoppedCount).toBe(1);
    expect(harness.provider.counts().startedCount).toBe(1);
  });

  it("persists the completion contract across restart-in-place handoffs", async () => {
    const harness = await createHarness();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-homer-completion-contract"),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: asMessageId("msg-homer-completion-contract"),
          role: "user",
          text: [
            "Your task is implement the next Homer endurance fix.",
            "",
            "Start by reading:",
            "- docs/t3homer-successor-thread-beta-plan.md",
            "- docs/t3homer-endurance-next-steps.md",
            "",
            "Constraints:",
            "- keep Homer deterministic and server-side",
            "",
            "When all tasks are complete, say exactly `I'm done`.",
          ].join("\n"),
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-04-12T21:40:00.000Z",
      }),
    );

    await Effect.runPromise(
      harness.supervisor.forceHandoff({
        threadId: asThreadId("thread-1"),
        createdAt: "2026-04-12T21:41:00.000Z",
        reason: "Restart in place should preserve the completion contract.",
      }),
    );

    const thread = await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.session?.status === "ready" &&
        candidate.homerTaskAnchor?.requiredExactCompletionPhrase === "I'm done",
    );

    const handoffActivity = thread.activities.find(
      (activity) => activity.kind === T3_HOMER_ACTIVITY_KINDS.handoffPrepared,
    );
    const handoffPayload = handoffActivity?.payload as
      | {
          taskAnchor?: {
            requiredExactCompletionPhrase?: string | null;
            completionChecks?: string[];
          };
        }
      | undefined;

    expect(thread.homerManagedWorkState).toEqual({
      status: "active",
      executionPolicy: "restart_in_place",
      activatedAt: "2026-04-12T21:41:00.000Z",
      updatedAt: "2026-04-12T21:41:00.000Z",
    });
    expect(thread.homerTaskAnchor?.requiredExactCompletionPhrase).toBe("I'm done");
    expect(thread.homerTaskAnchor?.completionChecks).toContain(
      "When all tasks are complete, say exactly `I'm done`.",
    );
    expect(handoffPayload?.taskAnchor?.requiredExactCompletionPhrase).toBe("I'm done");
    expect(handoffPayload?.taskAnchor?.completionChecks).toContain(
      "When all tasks are complete, say exactly `I'm done`.",
    );
  });

  it("preserves mid-session instruction updates across restart-in-place handoffs", async () => {
    const harness = await createHarness();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-homer-restart-instruction-base"),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: asMessageId("msg-homer-restart-instruction-base"),
          role: "user",
          text: [
            "Your task is implement the Homer safe fix.",
            "",
            "Start by reading:",
            "- docs/HomerMinimalSafeFix.md",
          ].join("\n"),
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-04-13T10:00:00.000Z",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-homer-restart-instruction-update"),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: asMessageId("msg-homer-restart-instruction-update"),
          role: "user",
          text: "Use $collaboration-defaults and work autonomously.",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-04-13T10:01:00.000Z",
      }),
    );

    await Effect.runPromise(
      harness.supervisor.forceHandoff({
        threadId: asThreadId("thread-1"),
        createdAt: "2026-04-13T10:02:00.000Z",
        reason: "Restart in place should preserve the latest instruction delta.",
      }),
    );

    const thread = await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.session?.status === "ready" &&
        candidate.homerTaskAnchor?.revision === 2 &&
        candidate.messages.some(
          (message) =>
            message.role === "user" && message.text.includes("T3 Homer managed-work continuation."),
        ),
    );

    const continuationPrompt =
      thread.messages.find(
        (message) =>
          message.role === "user" && message.text.includes("T3 Homer managed-work continuation."),
      )?.text ?? "";

    expect(thread.homerTaskAnchor?.revision).toBe(2);
    expect(thread.homerTaskAnchor?.authoritativeUserMessageId).toBe(
      asMessageId("msg-homer-restart-instruction-update"),
    );
    expect(thread.homerTaskAnchor?.instructionDeltaSnapshot?.snapshotRevision).toBe(2);
    expect(thread.homerTaskAnchor?.instructionDeltaSnapshot?.instructionDeltas).toContain(
      "Use $collaboration-defaults and work autonomously.",
    );
    expect(continuationPrompt).toContain("Assignment revision: 2");
    expect(continuationPrompt).toContain("Use $collaboration-defaults and work autonomously.");
  });

  it("refreshes objective from a free-form actionable instruction before restart handoff", async () => {
    const harness = await createHarness();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-homer-freeform-objective-base"),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: asMessageId("msg-homer-freeform-objective-base"),
          role: "user",
          text: "Implement successor fallback docs",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-04-13T11:00:00.000Z",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-homer-freeform-objective-update"),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: asMessageId("msg-homer-freeform-objective-update"),
          role: "user",
          text: "This is too wide, put them on top of each other, we have the space.",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-04-13T11:01:00.000Z",
      }),
    );

    await Effect.runPromise(
      harness.supervisor.forceHandoff({
        threadId: asThreadId("thread-1"),
        createdAt: "2026-04-13T11:02:00.000Z",
        reason: "Verify free-form objective continuity in managed handoff.",
      }),
    );

    const thread = await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.session?.status === "ready" &&
        candidate.homerTaskAnchor?.authoritativeUserMessageId ===
          asMessageId("msg-homer-freeform-objective-update") &&
        candidate.messages.some(
          (message) =>
            message.role === "user" && message.text.includes("T3 Homer managed-work continuation."),
        ),
    );

    const continuationPrompt =
      thread.messages.find(
        (message) =>
          message.role === "user" && message.text.includes("T3 Homer managed-work continuation."),
      )?.text ?? "";

    expect(thread.homerTaskAnchor?.objective).toContain(
      "This is too wide, put them on top of each other, we have the space.",
    );
    expect(continuationPrompt).toContain(
      "Objective: This is too wide, put them on top of each other, we have the space.",
    );
  });

  it("preserves mid-session instruction updates across explicitly triggered successor-thread handoffs", async () => {
    const harness = await createHarness();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-homer-successor-instruction-base"),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: asMessageId("msg-homer-successor-instruction-base"),
          role: "user",
          text: [
            "Your task is implement the Homer safe fix.",
            "",
            "Start by reading:",
            "- docs/HomerMinimalSafeFix.md",
          ].join("\n"),
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-04-13T10:10:00.000Z",
      }),
    );

    await Effect.runPromise(
      harness.supervisor.forceHandoff({
        threadId: asThreadId("thread-1"),
        createdAt: "2026-04-13T10:11:00.000Z",
        reason: "First intervention keeps the thread in place.",
      }),
    );

    await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.session?.status === "ready" &&
        candidate.homerManagedWorkState?.executionPolicy === "restart_in_place",
    );

    await Effect.runPromise(
      harness.supervisor.handleUserTurn({
        threadId: asThreadId("thread-1"),
        text: "Use $collaboration-defaults and work autonomously.",
        createdAt: "2026-04-13T10:12:00.000Z",
      }),
    );

    await waitForThread(harness.engine, (candidate) => candidate.homerManagedWorkState === null);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-homer-successor-instruction-update"),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: asMessageId("msg-homer-successor-instruction-update"),
          role: "user",
          text: "Use $collaboration-defaults and work autonomously.",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-04-13T10:12:30.000Z",
      }),
    );

    await Effect.runPromise(
      harness.supervisor.forceHandoff({
        threadId: asThreadId("thread-1"),
        createdAt: "2026-04-13T10:13:00.000Z",
        reason: "Manual successor trigger should preserve the updated instructions.",
        executionPolicy: "spawn_successor_thread",
      }),
    );

    const sourceThread = await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.homerSuccessorThreadId !== null && candidate.session?.status === "stopped",
    );
    const successorThreadId = sourceThread.homerSuccessorThreadId!;

    const successorThread = await waitForThreadById(
      harness.engine,
      successorThreadId,
      (candidate) =>
        candidate.session?.status === "ready" &&
        candidate.messages.some(
          (message) =>
            message.role === "user" && message.text.includes("T3 Homer successor-thread handoff."),
        ),
    );

    const handoffPrompt =
      successorThread.messages.find(
        (message) =>
          message.role === "user" && message.text.includes("T3 Homer successor-thread handoff."),
      )?.text ?? "";

    expect(sourceThread.homerTaskAnchor?.revision).toBe(2);
    expect(sourceThread.homerTaskAnchor?.authoritativeUserMessageId).toBe(
      asMessageId("msg-homer-successor-instruction-update"),
    );
    expect(sourceThread.homerTaskAnchor?.instructionDeltaSnapshot?.snapshotRevision).toBe(2);
    expect(successorThread.homerTaskAnchor?.revision).toBe(2);
    expect(successorThread.homerTaskAnchor?.instructionDeltaSnapshot?.instructionDeltas).toContain(
      "Use $collaboration-defaults and work autonomously.",
    );
    expect(handoffPrompt).toContain("Assignment revision: 2");
    expect(handoffPrompt).toContain("Use $collaboration-defaults and work autonomously.");
  });

  it("keeps continuation and successor handoff prompts actionable without Homer meta chatter", async () => {
    const harness = await createHarness();
    const objectiveUrl = "https://github.com/soolafsen/t3code/blob/dev/docs/HomerMinimalSafeFix.md";
    const executableObjective = `Objective: Implement the tasks defined in ${objectiveUrl} in this repository.`;

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-homer-url-objective-base"),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: asMessageId("msg-homer-url-objective-base"),
          role: "user",
          text: `Read this and implement it: ${objectiveUrl}`,
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-04-13T10:30:00.000Z",
      }),
    );

    await Effect.runPromise(
      harness.supervisor.forceHandoff({
        threadId: asThreadId("thread-1"),
        createdAt: "2026-04-13T10:31:00.000Z",
        reason: "Prepare a managed continuation prompt.",
      }),
    );

    const resumedThread = await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.session?.status === "ready" &&
        candidate.messages.some(
          (message) =>
            message.role === "user" && message.text.includes("T3 Homer managed-work continuation."),
        ),
    );

    const continuationPrompt =
      resumedThread.messages
        .toReversed()
        .find(
          (message) =>
            message.role === "user" && message.text.includes("T3 Homer managed-work continuation."),
        )?.text ?? "";
    expect(continuationPrompt).toContain(executableObjective);
    expect(continuationPrompt).toContain("Execution directives:");
    expect(continuationPrompt).not.toContain(
      "Latest user input: T3 Homer managed-work continuation.",
    );
    expect(continuationPrompt).not.toContain(
      "Latest user input: T3 Homer successor-thread handoff.",
    );
    expect(continuationPrompt).not.toContain("Authorit...");

    await Effect.runPromise(
      harness.supervisor.forceHandoff({
        threadId: asThreadId("thread-1"),
        createdAt: "2026-04-13T10:32:00.000Z",
        reason: "Second restart attempt should still stay in place.",
      }),
    );
    await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.session?.status === "ready" &&
        candidate.homerSuccessorThreadId === null &&
        harness.provider.counts().startedCount === 2,
    );

    await Effect.runPromise(
      harness.supervisor.forceHandoff({
        threadId: asThreadId("thread-1"),
        createdAt: "2026-04-13T10:33:00.000Z",
        reason: "Promote to successor after repeated restart-in-place failures.",
      }),
    );

    const sourceThread = await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.homerSuccessorThreadId !== null && candidate.session?.status === "stopped",
    );
    const successorThreadId = sourceThread.homerSuccessorThreadId!;

    const successorThread = await waitForThreadById(
      harness.engine,
      successorThreadId,
      (candidate) =>
        candidate.session?.status === "ready" &&
        candidate.messages.some(
          (message) =>
            message.role === "user" && message.text.includes("T3 Homer successor-thread handoff."),
        ),
    );

    const successorPrompt =
      successorThread.messages
        .toReversed()
        .find(
          (message) =>
            message.role === "user" && message.text.includes("T3 Homer successor-thread handoff."),
        )?.text ?? "";
    expect(successorPrompt).toContain(executableObjective);
    expect(successorPrompt).toContain("Execution directives:");
    expect(successorPrompt).not.toContain("Latest user input: T3 Homer managed-work continuation.");
    expect(successorPrompt).not.toContain("Latest user input: T3 Homer successor-thread handoff.");
    expect(successorPrompt).not.toContain("Authorit...");
  });

  it("increments revision only for real instruction changes, not managed status checks", async () => {
    const harness = await createHarness();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-homer-revision-base"),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: asMessageId("msg-homer-revision-base"),
          role: "user",
          text: [
            "Your task is implement the Homer safe fix.",
            "",
            "Start by reading:",
            "- docs/HomerMinimalSafeFix.md",
          ].join("\n"),
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-04-13T10:20:00.000Z",
      }),
    );

    await Effect.runPromise(
      harness.supervisor.forceHandoff({
        threadId: asThreadId("thread-1"),
        createdAt: "2026-04-13T10:21:00.000Z",
        reason: "Prepare managed continuation before testing status checks.",
      }),
    );

    const managedThread = await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.session?.status === "ready" &&
        candidate.homerManagedWorkState?.status === "active",
    );
    expect(managedThread.homerTaskAnchor?.revision).toBe(1);

    const result = await Effect.runPromise(
      harness.supervisor.handleUserTurn({
        threadId: asThreadId("thread-1"),
        text: "Are you still working on the tasks?",
        createdAt: "2026-04-13T10:22:00.000Z",
      }),
    );

    expect(result).toBe("handled");

    const resumedThread = await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.homerManagedWorkState?.updatedAt === "2026-04-13T10:22:00.000Z" &&
        candidate.messages.some(
          (message) =>
            message.role === "user" &&
            message.text.includes("Managed follow-up kind: status_check"),
        ),
    );

    const continuationPrompt =
      resumedThread.messages.find(
        (message) =>
          message.role === "user" && message.text.includes("Managed follow-up kind: status_check"),
      )?.text ?? "";

    expect(resumedThread.homerTaskAnchor?.revision).toBe(1);
    expect(resumedThread.homerTaskAnchor?.authoritativeUserMessageId).toBe(
      asMessageId("msg-homer-revision-base"),
    );
    expect(resumedThread.homerTaskAnchor?.instructionDeltaSnapshot?.snapshotRevision).toBe(1);
    expect(continuationPrompt).toContain("Assignment revision: 1");
    expect(continuationPrompt).not.toContain("Are you still working on the tasks?");
  });

  it("uses restart-in-place for the first missing-checkpoint recovery", async () => {
    const harness = await createHarness();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-homer-first-missing-diff"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-missing-1"),
        completedAt: "2026-04-13T12:00:00.000Z",
        checkpointRef: checkpointRefForThreadTurn(asThreadId("thread-1"), 1),
        status: "missing",
        files: [],
        checkpointTurnCount: 1,
        createdAt: "2026-04-13T12:00:00.000Z",
      }),
    );

    const thread = await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.homerManagedWorkState?.executionPolicy === "restart_in_place" &&
        candidate.session?.status === "ready",
    );

    expect(thread.homerSuccessorThreadId).toBeNull();
    expect(thread.homerTransitionKind).toBeNull();
    expect(harness.provider.counts().stoppedCount).toBe(1);
    expect(harness.provider.counts().startedCount).toBe(1);
  });

  it("carries the latest non-ready checkpoint ref into managed continuation prompts", async () => {
    const harness = await createHarness();
    const missingCheckpointRef = checkpointRefForThreadTurn(asThreadId("thread-1"), 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-homer-missing-checkpoint-ref"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-missing-ref"),
        completedAt: "2026-04-13T12:05:00.000Z",
        checkpointRef: missingCheckpointRef,
        status: "missing",
        files: [],
        checkpointTurnCount: 1,
        createdAt: "2026-04-13T12:05:00.000Z",
      }),
    );

    const thread = await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.session?.status === "ready" &&
        candidate.messages.some(
          (message) =>
            message.role === "user" && message.text.includes("T3 Homer managed-work continuation."),
        ),
    );

    const continuationPrompt =
      thread.messages
        .toReversed()
        .find(
          (message) =>
            message.role === "user" && message.text.includes("T3 Homer managed-work continuation."),
        )?.text ?? "";

    expect(continuationPrompt).toContain(`Checkpoint ref: ${missingCheckpointRef}`);
  });

  it("promotes to successor thread after repeated failed restart-in-place recoveries", async () => {
    const harness = await createHarness();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-homer-repeated-failure-assignment"),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: asMessageId("msg-homer-repeated-failure-assignment"),
          role: "user",
          text: "Implement docs/successorFallbackFunctionality.md exactly.",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-04-13T12:01:00.000Z",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-homer-missing-diff-1"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-missing-a"),
        completedAt: "2026-04-13T12:02:00.000Z",
        checkpointRef: checkpointRefForThreadTurn(asThreadId("thread-1"), 1),
        status: "missing",
        files: [],
        checkpointTurnCount: 1,
        createdAt: "2026-04-13T12:02:00.000Z",
      }),
    );

    await waitForThread(harness.engine, () => harness.provider.counts().startedCount === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-homer-missing-diff-2"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-missing-b"),
        completedAt: "2026-04-13T12:03:00.000Z",
        checkpointRef: checkpointRefForThreadTurn(asThreadId("thread-1"), 2),
        status: "missing",
        files: [],
        checkpointTurnCount: 2,
        createdAt: "2026-04-13T12:03:00.000Z",
      }),
    );

    await waitForThread(harness.engine, () => harness.provider.counts().startedCount === 2);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-homer-missing-diff-3"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-missing-c"),
        completedAt: "2026-04-13T12:04:00.000Z",
        checkpointRef: checkpointRefForThreadTurn(asThreadId("thread-1"), 3),
        status: "missing",
        files: [],
        checkpointTurnCount: 3,
        createdAt: "2026-04-13T12:04:00.000Z",
      }),
    );

    const sourceThread = await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.homerSuccessorThreadId !== null &&
        candidate.session?.status === "stopped" &&
        candidate.activities.some(
          (activity) => activity.kind === T3_HOMER_ACTIVITY_KINDS.successorThreadSpawned,
        ),
    );

    const promotionActivity = sourceThread.activities
      .toReversed()
      .find((activity) => activity.kind === T3_HOMER_ACTIVITY_KINDS.escalated);
    const promotionPayload = promotionActivity?.payload as
      | {
          triggerKind?: string;
          attemptCount?: number;
          assignmentRevision?: number;
          lastKnownTurnId?: string | null;
          checkpointRef?: string | null;
        }
      | undefined;

    expect(sourceThread.homerTransitionKind).toBe("spawn_successor_thread");
    expect(promotionPayload).toEqual(
      expect.objectContaining({
        triggerKind: "repeated_restart_failure",
        attemptCount: 2,
        assignmentRevision: 1,
      }),
    );
    expect(promotionPayload?.lastKnownTurnId).toBe("turn-missing-c");
    expect(
      typeof promotionPayload?.checkpointRef === "string" ||
        promotionPayload?.checkpointRef === null,
    ).toBe(true);
  });

  it("does not treat managed status checks as restart-attempt increments", async () => {
    const harness = await createHarness();

    await Effect.runPromise(
      harness.supervisor.forceHandoff({
        threadId: asThreadId("thread-1"),
        createdAt: "2026-04-13T12:10:00.000Z",
        reason: "First recovery attempt.",
      }),
    );
    await waitForThread(harness.engine, () => harness.provider.counts().startedCount === 1);

    const followUpResult = await Effect.runPromise(
      harness.supervisor.handleUserTurn({
        threadId: asThreadId("thread-1"),
        text: "status",
        createdAt: "2026-04-13T12:11:00.000Z",
      }),
    );
    expect(followUpResult).toBe("handled");

    await Effect.runPromise(
      harness.supervisor.forceHandoff({
        threadId: asThreadId("thread-1"),
        createdAt: "2026-04-13T12:12:00.000Z",
        reason: "Second recovery attempt should still stay in place.",
      }),
    );

    const thread = await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.session?.status === "ready" &&
        candidate.homerManagedWorkState?.executionPolicy === "restart_in_place" &&
        harness.provider.counts().startedCount === 2,
    );

    expect(thread.homerSuccessorThreadId).toBeNull();
    expect(harness.provider.counts().stoppedCount).toBe(2);
  });

  it("resets restart-attempt tracking after a successful completed turn", async () => {
    const harness = await createHarness();

    await Effect.runPromise(
      harness.supervisor.forceHandoff({
        threadId: asThreadId("thread-1"),
        createdAt: "2026-04-13T12:20:00.000Z",
        reason: "First recovery attempt.",
      }),
    );
    await waitForThread(harness.engine, () => harness.provider.counts().startedCount === 1);

    await Effect.runPromise(
      harness.supervisor.forceHandoff({
        threadId: asThreadId("thread-1"),
        createdAt: "2026-04-13T12:21:00.000Z",
        reason: "Second recovery attempt.",
      }),
    );
    await waitForThread(harness.engine, () => harness.provider.counts().startedCount === 2);

    harness.provider.emit({
      type: "turn.completed",
      eventId: asEventId("evt-homer-reset-success"),
      provider: "codex",
      createdAt: "2026-04-13T12:21:30.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-success-reset"),
      payload: {
        state: "completed",
      },
    });

    await Effect.runPromise(
      harness.supervisor.forceHandoff({
        threadId: asThreadId("thread-1"),
        createdAt: "2026-04-13T12:22:00.000Z",
        reason: "Post-success recovery should stay in place.",
      }),
    );

    const thread = await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.session?.status === "ready" &&
        candidate.homerManagedWorkState?.executionPolicy === "restart_in_place" &&
        harness.provider.counts().startedCount === 3,
    );

    expect(thread.homerSuccessorThreadId).toBeNull();
    expect(thread.homerTransitionKind).toBeNull();
  });

  it("promotes to successor thread when a requested turn stays pending past timeout", async () => {
    const harness = await createHarness();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-homer-pending-timeout-start"),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: asMessageId("msg-homer-pending-timeout-start"),
          role: "user",
          text: "Continue managed work.",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-04-13T12:30:00.000Z",
      }),
    );

    harness.provider.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-homer-pending-timeout"),
      provider: "codex",
      createdAt: "2026-04-13T12:30:21.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-pending-timeout"),
      payload: {
        message: "Still waiting for provider turn start.",
      },
    });

    const sourceThread = await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.homerSuccessorThreadId !== null &&
        candidate.session?.status === "stopped" &&
        candidate.activities.some(
          (activity) => activity.kind === T3_HOMER_ACTIVITY_KINDS.successorThreadSpawned,
        ),
    );

    const promotionActivity = sourceThread.activities
      .toReversed()
      .find((activity) => activity.kind === T3_HOMER_ACTIVITY_KINDS.escalated);
    const promotionPayload = promotionActivity?.payload as
      | {
          triggerKind?: string;
          attemptCount?: number;
          assignmentRevision?: number;
          lastKnownTurnId?: string | null;
          checkpointRef?: string | null;
        }
      | undefined;

    expect(promotionPayload).toEqual(
      expect.objectContaining({
        triggerKind: "pending_turn_timeout",
        attemptCount: 0,
        assignmentRevision: 1,
      }),
    );
    expect(promotionPayload?.lastKnownTurnId).toBe("turn-pending-timeout");
  });

  it("records escalation evidence for explicit manual successor promotion", async () => {
    const harness = await createHarness();

    await Effect.runPromise(
      harness.supervisor.forceHandoff({
        threadId: asThreadId("thread-1"),
        createdAt: "2026-04-13T12:40:00.000Z",
        reason: "Manual successor-thread validation.",
        executionPolicy: "spawn_successor_thread",
      }),
    );

    const sourceThread = await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.homerSuccessorThreadId !== null &&
        candidate.activities.some(
          (activity) => activity.kind === T3_HOMER_ACTIVITY_KINDS.escalated,
        ),
    );

    const promotionActivity = sourceThread.activities
      .toReversed()
      .find((activity) => activity.kind === T3_HOMER_ACTIVITY_KINDS.escalated);
    const payload = promotionActivity?.payload as
      | {
          triggerKind?: string;
          attemptCount?: number;
          assignmentRevision?: number;
          lastKnownTurnId?: string | null;
          checkpointRef?: string | null;
        }
      | undefined;

    expect(payload).toEqual(
      expect.objectContaining({
        triggerKind: "manual",
        attemptCount: 0,
        assignmentRevision: 1,
      }),
    );
    expect("lastKnownTurnId" in (payload ?? {})).toBe(true);
    expect("checkpointRef" in (payload ?? {})).toBe(true);
  });

  it("spawns a successor thread after repeated in-place restart failures and retires the old authority", async () => {
    const harness = await createHarness();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-homer-authoritative-assignment"),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: asMessageId("msg-homer-assignment"),
          role: "user",
          text: [
            "Your task is implement successor-thread beta for Homer.",
            "",
            "Start by reading:",
            "- docs/t3homer-successor-thread-beta-plan.md",
            "",
            "Constraints:",
            "- keep Homer deterministic and server-side",
            "- keep restart in place",
            "",
            "Non-goals:",
            "- no model-written handoffs",
            "- no autonomous replanning",
            "",
            "When all tasks are complete, say exactly `I'm done`.",
          ].join("\n"),
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-04-12T21:59:00.000Z",
      }),
    );

    await Effect.runPromise(
      harness.supervisor.forceHandoff({
        threadId: asThreadId("thread-1"),
        createdAt: "2026-04-12T22:00:00.000Z",
        reason: "First intervention should stay in place.",
      }),
    );

    await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.activities.some(
          (activity) => activity.kind === T3_HOMER_ACTIVITY_KINDS.sessionStarted,
        ) && candidate.session?.status === "ready",
    );

    await Effect.runPromise(
      harness.supervisor.forceHandoff({
        threadId: asThreadId("thread-1"),
        createdAt: "2026-04-12T22:04:00.000Z",
        reason: "Second intervention should still stay in place.",
      }),
    );
    await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.session?.status === "ready" &&
        candidate.homerSuccessorThreadId === null &&
        harness.provider.counts().startedCount === 2,
    );

    await Effect.runPromise(
      harness.supervisor.forceHandoff({
        threadId: asThreadId("thread-1"),
        createdAt: "2026-04-12T22:05:00.000Z",
        reason: "Third intervention should promote to a successor thread.",
      }),
    );

    const sourceThread = await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.homerSuccessorThreadId !== null &&
        candidate.session?.status === "stopped" &&
        candidate.activities.some(
          (activity) => activity.kind === T3_HOMER_ACTIVITY_KINDS.successorThreadSpawned,
        ),
    );

    const deadline = Date.now() + 2_000;
    let successorThread: Awaited<ReturnType<typeof readThreads>>[number] | null = null;
    while (Date.now() < deadline) {
      const threads = await readThreads(harness.engine);
      successorThread =
        threads.find((thread) => thread.homerSourceThreadId === asThreadId("thread-1")) ?? null;
      if (
        successorThread &&
        successorThread.session?.status === "ready" &&
        successorThread.activities.some(
          (activity) => activity.kind === T3_HOMER_ACTIVITY_KINDS.successorThreadCreated,
        ) &&
        successorThread.messages.some(
          (message) =>
            message.role === "user" && message.text.includes("T3 Homer successor-thread handoff."),
        )
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const successorHandoffMessage =
      successorThread?.messages.find(
        (message) =>
          message.role === "user" && message.text.includes("T3 Homer successor-thread handoff."),
      )?.text ?? null;

    expect(sourceThread.homerTransitionKind).toBe("spawn_successor_thread");
    expect(sourceThread.homerSuccessorThreadId).not.toBeNull();
    expect(sourceThread.homerManagedWorkState).toBeNull();
    expect(sourceThread.homerTaskAnchor?.objective).toContain(
      "implement successor-thread beta for Homer",
    );
    expect(sourceThread.homerTaskAnchor?.sourceDocumentPaths).toContain(
      "docs/t3homer-successor-thread-beta-plan.md",
    );
    expect(sourceThread.homerTaskAnchor?.requiredExactCompletionPhrase).toBe("I'm done");
    expect(sourceThread.homerTaskAnchor?.completionChecks).toContain(
      "When all tasks are complete, say exactly `I'm done`.",
    );
    expect(
      sourceThread.activities.some(
        (activity) => activity.kind === T3_HOMER_ACTIVITY_KINDS.handoffPrepared,
      ),
    ).toBe(true);
    expect(successorThread).not.toBeNull();
    expect(successorThread?.id).toBe(sourceThread.homerSuccessorThreadId);
    expect(successorThread?.homerSourceThreadId).toBe(asThreadId("thread-1"));
    expect(successorThread?.homerTransitionKind).toBe("spawn_successor_thread");
    expect(successorThread?.homerTaskAnchor).toEqual(sourceThread.homerTaskAnchor);
    expect(successorThread?.homerManagedWorkState).toEqual({
      status: "active",
      executionPolicy: "spawn_successor_thread",
      activatedAt: "2026-04-12T22:05:00.000Z",
      updatedAt: "2026-04-12T22:05:00.000Z",
    });
    expect(successorThread?.title).toBe("Homer Thread (Homer 2)");
    expect(successorThread?.messages.some((message) => message.role === "system")).toBe(true);
    expect(successorHandoffMessage).not.toBeNull();
    expect(successorHandoffMessage).toContain(
      "Objective: implement successor-thread beta for Homer.",
    );
    expect(successorHandoffMessage).toContain("docs/t3homer-successor-thread-beta-plan.md");
    expect(successorHandoffMessage).toContain("keep Homer deterministic and server-side");
    expect(successorHandoffMessage).toContain("no model-written handoffs");
    expect(successorHandoffMessage).toContain("Required exact completion phrase: I'm done");
    expect(successorHandoffMessage).toContain(
      "When all tasks are complete, say exactly `I'm done`.",
    );
    expect(successorHandoffMessage).toContain(
      "Treat short status checks, completion questions, and continue nudges as managed continuation, not as new assignments.",
    );
    expect(successorHandoffMessage).not.toContain("Are you still working on the tasks?");
    expect(harness.provider.counts().stoppedCount).toBe(3);
    expect(harness.provider.counts().startedCount).toBe(3);
    expect(harness.provider.counts().startedSessions.at(-1)?.threadId).toBe(successorThread?.id);
  });

  it("resumes managed work deterministically when a successor thread receives a managed follow-up", async () => {
    const harness = await createHarness();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-homer-successor-assignment"),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: asMessageId("msg-homer-successor-assignment"),
          role: "user",
          text: [
            "Your task is implement successor-thread beta for Homer.",
            "",
            "Read docs/t3homer-successor-thread-beta-plan.md and continue the same assignment.",
            "",
            "Constraints:",
            "- keep Homer deterministic and server-side",
            "",
            "Non-goals:",
            "- no model-written handoffs",
            "",
            "When all tasks are complete, say exactly `I'm done`.",
          ].join("\n"),
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-04-12T22:20:00.000Z",
      }),
    );

    await Effect.runPromise(
      harness.supervisor.forceHandoff({
        threadId: asThreadId("thread-1"),
        createdAt: "2026-04-12T22:21:00.000Z",
        reason: "Manual successor-thread validation.",
        executionPolicy: "spawn_successor_thread",
      }),
    );

    const sourceThread = await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.homerSuccessorThreadId !== null && candidate.session?.status === "stopped",
    );
    const successorThreadId = sourceThread.homerSuccessorThreadId!;

    const successorReadyDeadline = Date.now() + 2_000;
    let successorReadyThread: Awaited<ReturnType<typeof readThreadById>> = null;
    while (Date.now() < successorReadyDeadline) {
      successorReadyThread = await readThreadById(harness.engine, successorThreadId);
      if (
        successorReadyThread?.session?.status === "ready" &&
        successorReadyThread.homerManagedWorkState?.status === "active"
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(successorReadyThread?.session?.status).toBe("ready");
    expect(successorReadyThread?.homerManagedWorkState?.status).toBe("active");

    const result = await Effect.runPromise(
      harness.supervisor.handleUserTurn({
        threadId: successorThreadId,
        text: "look at your tasks",
        createdAt: "2026-04-12T22:22:00.000Z",
      }),
    );

    expect(result).toBe("handled");

    const continuationDeadline = Date.now() + 2_000;
    let successorThread: Awaited<ReturnType<typeof readThreadById>> = null;
    while (Date.now() < continuationDeadline) {
      successorThread = await readThreadById(harness.engine, successorThreadId);
      if (
        successorThread?.activities.some(
          (activity) => activity.kind === T3_HOMER_ACTIVITY_KINDS.statusCheckHandled,
        ) &&
        successorThread.messages.some(
          (message) =>
            message.role === "user" && message.text.includes("T3 Homer managed-work continuation."),
        ) &&
        successorThread.messages.some(
          (message) =>
            message.role === "system" && message.text.includes("Resuming managed work now."),
        )
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(successorThread).not.toBeNull();

    const handledActivity = successorThread!.activities.find(
      (activity) => activity.kind === T3_HOMER_ACTIVITY_KINDS.statusCheckHandled,
    );
    const handledPayload = handledActivity?.payload as
      | { followUpKind?: string; followUpText?: string }
      | undefined;
    const continuationPrompt =
      successorThread!.messages.find(
        (message) =>
          message.role === "user" && message.text.includes("T3 Homer managed-work continuation."),
      )?.text ?? null;

    expect(successorThread!.homerManagedWorkState).toEqual({
      status: "active",
      executionPolicy: "spawn_successor_thread",
      activatedAt: "2026-04-12T22:21:00.000Z",
      updatedAt: "2026-04-12T22:22:00.000Z",
    });
    expect(
      successorThread!.messages.some(
        (message) => message.role === "user" && message.text === "look at your tasks",
      ),
    ).toBe(false);
    expect(handledPayload).toEqual(
      expect.objectContaining({
        followUpKind: "resume_managed_work",
        followUpText: "look at your tasks",
      }),
    );
    expect(continuationPrompt).toContain("Managed follow-up kind: resume_managed_work");
    expect(continuationPrompt).toContain("This managed follow-up does not change the assignment.");
    expect(continuationPrompt).toContain("docs/t3homer-successor-thread-beta-plan.md");
    expect(continuationPrompt).toContain("keep Homer deterministic and server-side");
    expect(continuationPrompt).toContain("no model-written handoffs");
    expect(continuationPrompt).toContain("Required exact completion phrase: I'm done");
    expect(continuationPrompt).toContain("When all tasks are complete, say exactly `I'm done`.");
  });

  it("releases managed authority only when the user clearly takes back control", async () => {
    const harness = await createHarness();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-homer-user-takeover-assignment"),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: asMessageId("msg-homer-user-takeover-assignment"),
          role: "user",
          text: [
            "Your task is implement successor-thread beta for Homer.",
            "",
            "Read docs/t3homer-successor-thread-beta-plan.md and continue the same assignment.",
          ].join("\n"),
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-04-12T22:30:00.000Z",
      }),
    );

    await Effect.runPromise(
      harness.supervisor.forceHandoff({
        threadId: asThreadId("thread-1"),
        createdAt: "2026-04-12T22:31:00.000Z",
        reason: "Manual successor-thread validation.",
        executionPolicy: "spawn_successor_thread",
      }),
    );

    const sourceThread = await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.homerSuccessorThreadId !== null && candidate.session?.status === "stopped",
    );
    const successorThreadId = sourceThread.homerSuccessorThreadId!;

    const successorReadyDeadline = Date.now() + 2_000;
    let successorReadyThread: Awaited<ReturnType<typeof readThreadById>> = null;
    while (Date.now() < successorReadyDeadline) {
      successorReadyThread = await readThreadById(harness.engine, successorThreadId);
      if (
        successorReadyThread?.session?.status === "ready" &&
        successorReadyThread.homerManagedWorkState?.status === "active"
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(successorReadyThread?.session?.status).toBe("ready");
    expect(successorReadyThread?.homerManagedWorkState?.status).toBe("active");

    const result = await Effect.runPromise(
      harness.supervisor.handleUserTurn({
        threadId: successorThreadId,
        text: "Switch to documenting the API instead.",
        createdAt: "2026-04-12T22:32:00.000Z",
      }),
    );

    expect(result).toBe("pass_through");

    const successorThread = await readThreadById(harness.engine, successorThreadId);
    expect(successorThread?.homerManagedWorkState).toBeNull();
  });

  it("stops Homer recovery after an explicit user interrupt", async () => {
    const harness = await createHarness();

    await Effect.runPromise(
      harness.supervisor.forceHandoff({
        threadId: asThreadId("thread-1"),
        createdAt: "2026-04-12T22:40:00.000Z",
        reason: "Prepare managed state before testing stop behavior.",
      }),
    );

    const managedThread = await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.session?.status === "ready" &&
        candidate.homerManagedWorkState?.status === "active",
    );
    expect(managedThread.homerManagedWorkState?.status).toBe("active");
    expect(harness.provider.counts().startedCount).toBe(1);
    expect(harness.provider.counts().stoppedCount).toBe(1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-homer-user-stop"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-04-12T22:41:00.000Z",
      }),
    );

    await waitForThread(harness.engine, (candidate) => candidate.homerManagedWorkState === null);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-homer-post-stop-diff"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-after-stop"),
        completedAt: "2026-04-12T22:41:05.000Z",
        checkpointRef: checkpointRefForThreadTurn(asThreadId("thread-1"), 1),
        status: "missing",
        files: [],
        checkpointTurnCount: 1,
        createdAt: "2026-04-12T22:41:05.000Z",
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    const stoppedThread = await readThread(harness.engine);

    expect(stoppedThread?.homerManagedWorkState).toBeNull();
    expect(stoppedThread?.homerSuccessorThreadId).toBeNull();
    expect(harness.provider.counts().startedCount).toBe(1);
    expect(harness.provider.counts().stoppedCount).toBe(1);
  });

  it("supports an explicit successor-thread manual trigger for dev validation", async () => {
    const harness = await createHarness();

    const result = await Effect.runPromise(
      harness.supervisor.forceHandoff({
        threadId: asThreadId("thread-1"),
        createdAt: "2026-04-12T22:10:00.000Z",
        reason: "Manual successor-thread validation.",
        executionPolicy: "spawn_successor_thread",
      }),
    );

    expect(result).toBe("triggered");

    const sourceThread = await waitForThread(
      harness.engine,
      (candidate) =>
        candidate.homerSuccessorThreadId !== null && candidate.session?.status === "stopped",
    );
    const successorThread = await readThreadById(
      harness.engine,
      sourceThread.homerSuccessorThreadId!,
    );

    expect(sourceThread.homerSuccessorThreadId).not.toBeNull();
    expect(sourceThread.homerTransitionKind).toBe("spawn_successor_thread");
    expect(successorThread?.homerSourceThreadId).toBe(sourceThread.id);
    expect(
      successorThread?.activities.some(
        (activity) => activity.kind === T3_HOMER_ACTIVITY_KINDS.successorThreadCreated,
      ),
    ).toBe(true);
    expect(harness.provider.counts().stoppedCount).toBe(1);
    expect(harness.provider.counts().startedCount).toBe(1);
  });
});
