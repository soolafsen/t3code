import {
  CommandId,
  EventId,
  type OrchestrationEvent,
  type OrchestrationSession,
  type OrchestrationThread,
  type ProviderSession,
  type ProviderRuntimeEvent,
  type ThreadId,
  T3_HOMER_ACTIVITY_KINDS,
  TurnId,
} from "@t3tools/contracts";
import { Cause, Effect, Layer, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { T3HomerSupervisor, type T3HomerSupervisorShape } from "../Services/T3HomerSupervisor.ts";

const HOMER_PREPARE_USAGE_RATIO = 0.82;
const HOMER_WARNING_THRESHOLD = 3;
const HOMER_ESCALATION_THRESHOLD = 3;
const HOMER_GOAL_MAX_CHARS = 220;
const HOMER_DETAIL_MAX_CHARS = 180;

type SupervisorDomainEvent = Extract<
  OrchestrationEvent,
  {
    type: "thread.turn-start-requested" | "thread.turn-diff-completed";
  }
>;

type SupervisorInput =
  | {
      readonly source: "runtime";
      readonly event: ProviderRuntimeEvent;
    }
  | {
      readonly source: "domain";
      readonly event: SupervisorDomainEvent;
    };

type HomerState = {
  announced: boolean;
  supervisorState: "continue" | "prepare_handover" | "escalate";
  warningCount: number;
  errorCount: number;
  handoffCount: number;
  interventionInProgress: boolean;
  pendingReason: string | null;
  lastIntervenedTurnId: TurnId | null;
};

function createInitialState(): HomerState {
  return {
    announced: false,
    supervisorState: "continue",
    warningCount: 0,
    errorCount: 0,
    handoffCount: 0,
    interventionInProgress: false,
    pendingReason: null,
    lastIntervenedTurnId: null,
  };
}

function truncateValue(value: string | null | undefined, limit = HOMER_DETAIL_MAX_CHARS): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function toTurnId(value: TurnId | string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.make(String(value));
}

function hasHandledTurn(state: HomerState, turnId: TurnId | null): boolean {
  return turnId !== null && state.lastIntervenedTurnId === turnId;
}

function mapProviderSession(session: ProviderSession): OrchestrationSession {
  return {
    threadId: session.threadId,
    status:
      session.status === "connecting"
        ? "starting"
        : session.status === "running"
          ? "running"
          : session.status === "error"
            ? "error"
            : session.status === "closed"
              ? "stopped"
              : "ready",
    providerName: session.provider,
    runtimeMode: session.runtimeMode,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    updatedAt: session.updatedAt,
  };
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const serverSettings = yield* ServerSettingsService;

  const stateByThreadId = new Map<ThreadId, HomerState>();

  const getState = (threadId: ThreadId) => {
    const existing = stateByThreadId.get(threadId);
    if (existing) {
      return existing;
    }
    const created = createInitialState();
    stateByThreadId.set(threadId, created);
    return created;
  };

  const isEnabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.homer.enabled),
  );

  const serverCommandId = (tag: string): CommandId =>
    CommandId.make(`server:t3homer:${tag}:${crypto.randomUUID()}`);

  const resolveThread = Effect.fn("resolveThread")(function* (threadId: ThreadId) {
    const readModel = yield* orchestrationEngine.getReadModel();
    return {
      thread: readModel.threads.find((entry) => entry.id === threadId) ?? null,
      projects: readModel.projects,
    };
  });

  const appendActivity = Effect.fn("appendActivity")(function* (input: {
    readonly threadId: ThreadId;
    readonly kind: string;
    readonly summary: string;
    readonly createdAt: string;
    readonly tone?: "info" | "tool" | "approval" | "error";
    readonly payload?: unknown;
    readonly turnId?: TurnId | null;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone: input.tone ?? "info",
        kind: input.kind,
        summary: input.summary,
        payload: input.payload ?? {},
        turnId: input.turnId ?? null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const setThreadSession = Effect.fn("setThreadSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: serverCommandId("session-set"),
      threadId: input.threadId,
      session: input.session,
      createdAt: input.createdAt,
    });
  });

  const announceSupervisionIfNeeded = Effect.fn("announceSupervisionIfNeeded")(function* (input: {
    readonly threadId: ThreadId;
    readonly createdAt: string;
  }) {
    const state = getState(input.threadId);
    if (state.announced) {
      return;
    }
    state.announced = true;
    yield* appendActivity({
      threadId: input.threadId,
      kind: T3_HOMER_ACTIVITY_KINDS.supervising,
      summary: "T3Homer supervising this thread",
      createdAt: input.createdAt,
      payload: {
        mode: "background",
      },
    });
  });

  const buildHandoffPayload = (input: {
    readonly thread: OrchestrationThread;
    readonly reason: string;
  }) => {
    const latestUserMessage = input.thread.messages
      .toReversed()
      .find((message) => message.role === "user");
    const latestReadyCheckpoint = input.thread.checkpoints
      .toReversed()
      .find((checkpoint) => checkpoint.status === "ready");
    const latestCheckpoint = input.thread.checkpoints.at(-1) ?? null;
    const relevantCheckpoint = latestReadyCheckpoint ?? latestCheckpoint ?? null;
    const relevantFilePaths = relevantCheckpoint?.files.map((file) => file.path) ?? [];

    return {
      threadId: input.thread.id,
      goal: truncateValue(latestUserMessage?.text, HOMER_GOAL_MAX_CHARS),
      verifiedDone:
        latestReadyCheckpoint !== undefined && latestReadyCheckpoint !== null
          ? [
              `Latest known-good checkpoint is turn ${latestReadyCheckpoint.checkpointTurnCount}.`,
              ...latestReadyCheckpoint.files.slice(0, 8).map((file) => `Touched ${file.path}`),
            ]
          : [],
      verifiedNotDone: [input.reason],
      nextAction: "Continue from a fresh provider session using the current repo state.",
      verificationStillRequired:
        latestCheckpoint?.status === "ready"
          ? ["Run the next verification pass after the fresh session picks up the thread."]
          : [
              "Checkpoint verification is incomplete. Re-check the working tree before broad edits.",
            ],
      relevantFilePaths,
      checkpointRef: latestReadyCheckpoint?.checkpointRef ?? null,
      restartPolicy: "restart_from_current_state",
    };
  };

  const appendEscalationActivity = Effect.fn("appendEscalationActivity")(function* (input: {
    readonly threadId: ThreadId;
    readonly reason: string;
    readonly createdAt: string;
    readonly turnId: TurnId | null;
    readonly restartCount: number;
  }) {
    yield* appendActivity({
      threadId: input.threadId,
      kind: T3_HOMER_ACTIVITY_KINDS.escalated,
      summary: "T3Homer needs manual attention",
      tone: "error",
      turnId: input.turnId,
      createdAt: input.createdAt,
      payload: {
        reason: input.reason,
        restartCount: input.restartCount,
      },
    });
  });

  const restartFromCurrentState = Effect.fn("restartFromCurrentState")(function* (input: {
    readonly threadId: ThreadId;
    readonly reason: string;
    readonly createdAt: string;
    readonly interruptActiveTurn: boolean;
    readonly turnId: TurnId | null;
  }) {
    const state = getState(input.threadId);
    if (state.interventionInProgress || hasHandledTurn(state, input.turnId)) {
      return;
    }
    state.interventionInProgress = true;

    const resolved = yield* resolveThread(input.threadId);
    const thread = resolved.thread;
    if (!thread) {
      state.interventionInProgress = false;
      return;
    }

    const nextRestartCount = state.handoffCount + 1;
    if (nextRestartCount >= HOMER_ESCALATION_THRESHOLD) {
      state.supervisorState = "escalate";
      yield* appendEscalationActivity({
        threadId: input.threadId,
        reason: input.reason,
        createdAt: input.createdAt,
        turnId: input.turnId,
        restartCount: nextRestartCount,
      });
    }

    const existingSession = thread.session;
    const stopKind = input.interruptActiveTurn
      ? T3_HOMER_ACTIVITY_KINDS.sessionInterrupted
      : T3_HOMER_ACTIVITY_KINDS.sessionEnded;
    const stopSummary = input.interruptActiveTurn
      ? "T3Homer interrupted the current session"
      : "T3Homer ended the current session";

    if (existingSession && existingSession.status !== "stopped") {
      yield* appendActivity({
        threadId: input.threadId,
        kind: stopKind,
        summary: stopSummary,
        createdAt: input.createdAt,
        turnId: input.turnId,
        payload: {
          reason: input.reason,
          provider: existingSession.providerName,
        },
      });

      const stopExit = yield* Effect.exit(
        providerService.stopSession({ threadId: input.threadId }),
      );
      if (stopExit._tag === "Failure") {
        yield* appendEscalationActivity({
          threadId: input.threadId,
          reason: truncateValue(Cause.pretty(stopExit.cause)),
          createdAt: input.createdAt,
          turnId: input.turnId,
          restartCount: nextRestartCount,
        });
        state.interventionInProgress = false;
        return;
      }
    }

    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        threadId: input.threadId,
        status: "stopped",
        providerName: existingSession?.providerName ?? thread.modelSelection.provider,
        runtimeMode: existingSession?.runtimeMode ?? thread.runtimeMode,
        activeTurnId: null,
        lastError: existingSession?.lastError ?? null,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

    yield* appendActivity({
      threadId: input.threadId,
      kind: T3_HOMER_ACTIVITY_KINDS.handoffPrepared,
      summary: "T3Homer prepared a fresh-session handoff",
      createdAt: input.createdAt,
      turnId: input.turnId,
      payload: buildHandoffPayload({
        thread,
        reason: input.reason,
      }),
    });

    const cwd = resolveThreadWorkspaceCwd({
      thread,
      projects: resolved.projects,
    });
    const startExit = yield* Effect.exit(
      providerService.startSession(input.threadId, {
        threadId: input.threadId,
        provider: thread.modelSelection.provider,
        ...(cwd ? { cwd } : {}),
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
      }),
    );
    if (startExit._tag === "Failure") {
      yield* appendEscalationActivity({
        threadId: input.threadId,
        reason: truncateValue(Cause.pretty(startExit.cause)),
        createdAt: input.createdAt,
        turnId: input.turnId,
        restartCount: nextRestartCount,
      });
      state.interventionInProgress = false;
      state.handoffCount = nextRestartCount;
      state.lastIntervenedTurnId = input.turnId;
      return;
    }

    yield* setThreadSession({
      threadId: input.threadId,
      session: mapProviderSession(startExit.value),
      createdAt: input.createdAt,
    });

    yield* appendActivity({
      threadId: input.threadId,
      kind: T3_HOMER_ACTIVITY_KINDS.sessionStarted,
      summary: "T3Homer started a fresh session",
      createdAt: input.createdAt,
      turnId: null,
      payload: {
        reason: input.reason,
        provider: startExit.value.provider,
        restartCount: nextRestartCount,
      },
    });

    state.warningCount = 0;
    state.errorCount = 0;
    state.handoffCount = nextRestartCount;
    state.interventionInProgress = false;
    state.pendingReason = null;
    state.supervisorState = "continue";
    state.lastIntervenedTurnId = input.turnId;
  });

  const prepareHandoff = Effect.fn("prepareHandoff")(function* (input: {
    readonly threadId: ThreadId;
    readonly reason: string;
    readonly createdAt: string;
    readonly turnId: TurnId | null;
    readonly usageRatio?: number;
  }) {
    const state = getState(input.threadId);
    if (state.supervisorState !== "continue" || state.interventionInProgress) {
      return;
    }

    state.supervisorState = "prepare_handover";
    state.pendingReason = input.reason;
    yield* appendActivity({
      threadId: input.threadId,
      kind: T3_HOMER_ACTIVITY_KINDS.prepareHandoff,
      summary: "T3Homer is preparing a handoff",
      createdAt: input.createdAt,
      turnId: input.turnId,
      payload: {
        reason: input.reason,
        ...(input.usageRatio !== undefined ? { usageRatio: input.usageRatio } : {}),
      },
    });
  });

  const forceHandoff: T3HomerSupervisorShape["forceHandoff"] = Effect.fn("forceHandoff")(
    function* (input) {
      if (!(yield* isEnabled)) {
        return "disabled";
      }

      const resolved = yield* resolveThread(input.threadId);
      const thread = resolved.thread;
      if (!thread) {
        return "thread_not_found";
      }

      yield* announceSupervisionIfNeeded({
        threadId: input.threadId,
        createdAt: input.createdAt,
      });

      const shouldInterruptActiveTurn =
        thread.session?.status === "running" || thread.session?.activeTurnId !== null;
      yield* restartFromCurrentState({
        threadId: input.threadId,
        reason: truncateValue(input.reason) || "Manual Homer test requested.",
        createdAt: input.createdAt,
        interruptActiveTurn: shouldInterruptActiveTurn,
        turnId: null,
      });

      return "triggered";
    },
  );

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: SupervisorDomainEvent,
  ) {
    if (!(yield* isEnabled)) {
      return;
    }

    const state = getState(event.payload.threadId);

    if (event.type === "thread.turn-start-requested") {
      state.warningCount = 0;
      state.errorCount = 0;
      state.pendingReason = null;
      state.supervisorState = "continue";
      state.lastIntervenedTurnId = null;
      yield* announceSupervisionIfNeeded({
        threadId: event.payload.threadId,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    if (event.type === "thread.turn-diff-completed") {
      if (hasHandledTurn(state, event.payload.turnId) || state.interventionInProgress) {
        return;
      }
      if (event.payload.status === "ready") {
        return;
      }
      yield* restartFromCurrentState({
        threadId: event.payload.threadId,
        reason:
          event.payload.status === "error"
            ? "Checkpoint capture failed after the last turn."
            : "Checkpoint state is missing after the last turn.",
        createdAt: event.payload.completedAt,
        interruptActiveTurn: false,
        turnId: event.payload.turnId,
      });
    }
  });

  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (!(yield* isEnabled)) {
      return;
    }

    const state = getState(event.threadId);
    const turnId = toTurnId(event.turnId);

    switch (event.type) {
      case "thread.token-usage.updated": {
        const maxTokens = event.payload.usage.maxTokens;
        if (!maxTokens || maxTokens <= 0) {
          return;
        }
        const usageRatio = event.payload.usage.usedTokens / maxTokens;
        if (usageRatio >= HOMER_PREPARE_USAGE_RATIO) {
          yield* prepareHandoff({
            threadId: event.threadId,
            reason: `Context window reached ${(usageRatio * 100).toFixed(0)}% of capacity.`,
            createdAt: event.createdAt,
            turnId,
            usageRatio,
          });
        }
        return;
      }

      case "runtime.warning": {
        state.warningCount += 1;
        if (state.warningCount >= HOMER_WARNING_THRESHOLD) {
          yield* prepareHandoff({
            threadId: event.threadId,
            reason: `Runtime warnings accumulated (${state.warningCount}) during the current turn.`,
            createdAt: event.createdAt,
            turnId,
          });
        }
        return;
      }

      case "runtime.error": {
        state.errorCount += 1;
        if (state.interventionInProgress || hasHandledTurn(state, turnId)) {
          return;
        }
        yield* restartFromCurrentState({
          threadId: event.threadId,
          reason: truncateValue(event.payload.message),
          createdAt: event.createdAt,
          interruptActiveTurn: true,
          turnId,
        });
        return;
      }

      case "thread.state.changed": {
        if (event.payload.state !== "compacted") {
          return;
        }
        if (state.interventionInProgress || hasHandledTurn(state, turnId)) {
          return;
        }
        yield* restartFromCurrentState({
          threadId: event.threadId,
          reason: "Provider compacted the thread state, so Homer rotated to a fresh session.",
          createdAt: event.createdAt,
          interruptActiveTurn: true,
          turnId,
        });
        return;
      }

      case "turn.completed":
      case "turn.aborted": {
        if (state.supervisorState !== "prepare_handover") {
          return;
        }
        if (state.interventionInProgress || hasHandledTurn(state, turnId)) {
          return;
        }
        yield* restartFromCurrentState({
          threadId: event.threadId,
          reason: state.pendingReason ?? "T3Homer requested a clean handoff.",
          createdAt: event.createdAt,
          interruptActiveTurn: false,
          turnId,
        });
        return;
      }
    }
  });

  const processInput = (input: SupervisorInput) =>
    input.source === "domain" ? processDomainEvent(input.event) : processRuntimeEvent(input.event);

  const processInputSafely = (input: SupervisorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("t3homer supervisor failed to process input", {
          source: input.source,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: T3HomerSupervisorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.turn-diff-completed"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) => {
        switch (event.type) {
          case "thread.token-usage.updated":
          case "runtime.warning":
          case "runtime.error":
          case "thread.state.changed":
          case "turn.completed":
          case "turn.aborted":
            return worker.enqueue({ source: "runtime", event });
          default:
            return Effect.void;
        }
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
    forceHandoff,
  } satisfies T3HomerSupervisorShape;
});

export const T3HomerSupervisorLive = Layer.effect(T3HomerSupervisor, make);
