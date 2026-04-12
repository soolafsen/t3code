import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationMessage,
  type OrchestrationSession,
  type OrchestrationThread,
  type ProviderSession,
  type ProviderRuntimeEvent,
  T3_HOMER_ACTIVITY_KINDS,
  type T3HomerExecutionPolicy,
  type T3HomerHandoffPayload,
  type T3HomerManagedWorkState,
  type T3HomerTaskAnchor,
  ThreadId,
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
const HOMER_TITLE_SUFFIX_RE = /\s+\(Homer \d+\)$/;
const HOMER_SECTION_HEADER_RE = /^\s*([A-Za-z][A-Za-z\s/-]+):\s*$/;
const HOMER_STATUS_CHECK_RE =
  /^(are you still|still working|status\??$|status update|progress\??$|keep going\b|continue\b|are you done\b|done\??$|working on the tasks\??)/i;

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
  interventionCount: number;
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
    interventionCount: 0,
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

function normalizeTrimmedValues(values: ReadonlyArray<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.map((value) => value?.trim() ?? "").filter((value) => value.length > 0)),
  );
}

function toTurnId(value: TurnId | string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.make(String(value));
}

function hasHandledTurn(state: HomerState, turnId: TurnId | null): boolean {
  return turnId !== null && state.lastIntervenedTurnId === turnId;
}

function stripHomerTitleSuffix(title: string): string {
  return title.replace(HOMER_TITLE_SUFFIX_RE, "").trim();
}

function isStatusCheckMessage(text: string): boolean {
  const normalized = text.trim();
  return (
    normalized.length > 0 && normalized.length <= 200 && HOMER_STATUS_CHECK_RE.test(normalized)
  );
}

function isHomerInjectedUserMessage(text: string): boolean {
  return (
    text.startsWith("T3 Homer successor-thread handoff.") ||
    text.startsWith("T3 Homer managed-work continuation.")
  );
}

function extractSectionEntries(text: string, labels: ReadonlyArray<string>): string[] {
  const labelSet = new Set(labels.map((label) => label.toLowerCase()));
  const lines = text.split(/\r?\n/);
  const values: string[] = [];
  let collecting = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) {
      if (collecting && values.length > 0) {
        break;
      }
      continue;
    }

    const headerMatch = line.match(HOMER_SECTION_HEADER_RE);
    if (headerMatch) {
      collecting = labelSet.has(headerMatch[1]!.trim().toLowerCase());
      continue;
    }

    if (!collecting) {
      continue;
    }

    const bulletMatch = line.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      values.push(bulletMatch[1]!.trim());
      continue;
    }

    if (values.length > 0) {
      break;
    }
  }

  return normalizeTrimmedValues(values);
}

function extractSourceDocumentPaths(text: string): string[] {
  const matches =
    text.match(/(?:docs|apps|packages)\/[A-Za-z0-9._/-]+|https?:\/\/[^\s)>"']+/g) ?? [];
  return normalizeTrimmedValues(matches);
}

function extractObjective(text: string, fallback: string): string {
  const taskMatch = text.match(/^\s*Your task is\s+(.+)$/im);
  if (taskMatch?.[1]) {
    return truncateValue(taskMatch[1], HOMER_GOAL_MAX_CHARS) || fallback;
  }

  const goalEntries = extractSectionEntries(text, ["Goal"]);
  if (goalEntries.length > 0) {
    return truncateValue(goalEntries.join(" "), HOMER_GOAL_MAX_CHARS) || fallback;
  }

  const firstUsefulLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(
      (line) => line.length > 0 && !HOMER_SECTION_HEADER_RE.test(line) && !/^[-*]\s+/.test(line),
    );

  return truncateValue(firstUsefulLine, HOMER_GOAL_MAX_CHARS) || fallback;
}

function getUserMessages(thread: OrchestrationThread): OrchestrationMessage[] {
  return thread.messages.filter((message) => message.role === "user");
}

function getAuthoritativeUserMessages(thread: OrchestrationThread): OrchestrationMessage[] {
  const userMessages = getUserMessages(thread);
  const nonSyntheticMessages = userMessages.filter(
    (message) => !isStatusCheckMessage(message.text) && !isHomerInjectedUserMessage(message.text),
  );
  if (nonSyntheticMessages.length > 0) {
    return nonSyntheticMessages;
  }
  const nonStatusMessages = userMessages.filter((message) => !isStatusCheckMessage(message.text));
  return nonStatusMessages.length > 0 ? nonStatusMessages : userMessages;
}

function buildSuccessorHandoffPrompt(input: {
  readonly sourceThread: OrchestrationThread;
  readonly payload: T3HomerHandoffPayload;
}) {
  const { taskAnchor } = input.payload;
  const sections = [
    "T3 Homer successor-thread handoff.",
    "",
    `Source thread: ${input.payload.sourceThreadId}`,
    `Source title: ${input.sourceThread.title}`,
    `Execution policy: ${input.payload.executionPolicy}`,
    "",
    "Authoritative assignment:",
    `Objective: ${taskAnchor.objective}`,
    "",
    "Source docs:",
    ...(taskAnchor.sourceDocumentPaths.length > 0
      ? taskAnchor.sourceDocumentPaths.map((entry) => `- ${entry}`)
      : ["- None recorded."]),
    "",
    "Constraints:",
    ...(taskAnchor.constraints.length > 0
      ? taskAnchor.constraints.map((entry) => `- ${entry}`)
      : ["- None recorded."]),
    "",
    "Non-goals:",
    ...(taskAnchor.nonGoals.length > 0
      ? taskAnchor.nonGoals.map((entry) => `- ${entry}`)
      : ["- None recorded."]),
    "",
    `Branch expectation: ${taskAnchor.branchExpectation ?? "current branch context"}`,
    "",
    "Continuity rules:",
    "- This assignment remains authoritative until the user explicitly changes it.",
    "- Treat short status/progress questions as status checks, not as new assignments.",
    "- Do not ask what the original assignment was.",
    "",
    `Goal: ${input.payload.goal}`,
    "",
    "Verified done:",
    ...(input.payload.verifiedDone.length > 0
      ? input.payload.verifiedDone.map((entry) => `- ${entry}`)
      : ["- None recorded."]),
    "",
    "Verified not done:",
    ...(input.payload.verifiedNotDone.length > 0
      ? input.payload.verifiedNotDone.map((entry) => `- ${entry}`)
      : ["- No additional unfinished items were recorded."]),
    "",
    `Next action: ${input.payload.nextAction}`,
    "",
    "Verification still required:",
    ...(input.payload.verificationStillRequired.length > 0
      ? input.payload.verificationStillRequired.map((entry) => `- ${entry}`)
      : ["- None recorded."]),
    "",
    "Relevant files:",
    ...(input.payload.relevantFilePaths.length > 0
      ? input.payload.relevantFilePaths.map((entry) => `- ${entry}`)
      : ["- None recorded."]),
    "",
    `Checkpoint ref: ${input.payload.checkpointRef ?? "none"}`,
    "",
    "Continue the authoritative assignment above. Use this handoff and the repository state as the authority for what to do next.",
  ];
  return sections.join("\n");
}

function buildManagedContinuationPrompt(input: {
  readonly thread: OrchestrationThread;
  readonly taskAnchor: T3HomerTaskAnchor;
  readonly executionPolicy: T3HomerExecutionPolicy;
  readonly statusCheckText: string;
}) {
  const sections = [
    "T3 Homer managed-work continuation.",
    "",
    `Thread: ${input.thread.id}`,
    `Execution policy: ${input.executionPolicy}`,
    `Status check received: ${truncateValue(input.statusCheckText, 120)}`,
    "",
    "Authority rules:",
    "- This status check does not change the assignment.",
    "- Continue the existing authoritative task until the user gives a real new instruction.",
    "",
    `Objective: ${input.taskAnchor.objective}`,
    "",
    "Source docs:",
    ...(input.taskAnchor.sourceDocumentPaths.length > 0
      ? input.taskAnchor.sourceDocumentPaths.map((entry) => `- ${entry}`)
      : ["- None recorded."]),
    "",
    "Constraints:",
    ...(input.taskAnchor.constraints.length > 0
      ? input.taskAnchor.constraints.map((entry) => `- ${entry}`)
      : ["- None recorded."]),
    "",
    "Non-goals:",
    ...(input.taskAnchor.nonGoals.length > 0
      ? input.taskAnchor.nonGoals.map((entry) => `- ${entry}`)
      : ["- None recorded."]),
    "",
    `Branch expectation: ${input.taskAnchor.branchExpectation ?? "current branch context"}`,
    "",
    "Continue work from the current repository and thread state. Do not re-ask for the original assignment.",
  ];
  return sections.join("\n");
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
      threads: readModel.threads,
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

  const appendSystemMessage = Effect.fn("appendSystemMessage")(function* (input: {
    readonly threadId: ThreadId;
    readonly text: string;
    readonly createdAt: string;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.message.system.append",
      commandId: serverCommandId("system-message"),
      threadId: input.threadId,
      messageId: MessageId.make(`t3homer:system:${crypto.randomUUID()}`),
      text: input.text,
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

  const setManagedWorkState = Effect.fn("setManagedWorkState")(function* (input: {
    readonly threadId: ThreadId;
    readonly state: T3HomerManagedWorkState | null;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: serverCommandId("managed-work-state"),
      threadId: input.threadId,
      homerManagedWorkState: input.state,
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
      summary: "T3 Homer is supervising this thread",
      createdAt: input.createdAt,
      payload: {
        mode: "background",
      },
    });
  });

  const selectExecutionPolicy = (
    threadId: ThreadId,
    explicitPolicy?: T3HomerExecutionPolicy,
  ): T3HomerExecutionPolicy => {
    if (explicitPolicy) {
      return explicitPolicy;
    }
    const state = getState(threadId);
    return state.interventionCount >= 1 ? "spawn_successor_thread" : "restart_in_place";
  };

  const resolveTaskAnchor = Effect.fn("resolveTaskAnchor")(function* (input: {
    readonly thread: OrchestrationThread;
    readonly createdAt: string;
  }) {
    if (input.thread.homerTaskAnchor) {
      return input.thread.homerTaskAnchor;
    }

    const authoritativeMessages = getAuthoritativeUserMessages(input.thread);
    const authoritativeMessage = authoritativeMessages[0] ?? null;
    const authoritativeText = authoritativeMessage?.text ?? input.thread.title;
    const allRelevantText = authoritativeMessages.map((message) => message.text).join("\n\n");

    const taskAnchor: T3HomerTaskAnchor = {
      objective: extractObjective(authoritativeText, input.thread.title),
      sourceDocumentPaths: extractSourceDocumentPaths(allRelevantText),
      constraints: extractSectionEntries(authoritativeText, ["Constraints", "Constraint"]),
      nonGoals: extractSectionEntries(authoritativeText, ["Non-goals", "Non-goal", "Non goals"]),
      branchExpectation: input.thread.branch,
      authoritativeUserMessageId: authoritativeMessage?.id ?? null,
      updatedAt: input.createdAt,
    };

    yield* orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: serverCommandId("task-anchor-set"),
      threadId: input.thread.id,
      homerTaskAnchor: taskAnchor,
    });

    return taskAnchor;
  });

  const buildHandoffPayload = (input: {
    readonly thread: OrchestrationThread;
    readonly taskAnchor: T3HomerTaskAnchor;
    readonly reason: string;
    readonly executionPolicy: T3HomerExecutionPolicy;
  }): T3HomerHandoffPayload => {
    const authoritativeMessages = getAuthoritativeUserMessages(input.thread);
    const latestRelevantUserMessage = authoritativeMessages.at(-1) ?? null;
    const latestReadyCheckpoint = input.thread.checkpoints
      .toReversed()
      .find((checkpoint) => checkpoint.status === "ready");
    const latestCheckpoint = input.thread.checkpoints.at(-1) ?? null;
    const relevantCheckpoint = latestReadyCheckpoint ?? latestCheckpoint ?? null;
    const relevantFilePaths = normalizeTrimmedValues(
      relevantCheckpoint?.files.slice(0, 12).map((file) => file.path) ?? [],
    );

    return {
      sourceThreadId: input.thread.id,
      goal: input.taskAnchor.objective,
      taskAnchor: input.taskAnchor,
      verifiedDone:
        latestReadyCheckpoint !== undefined && latestReadyCheckpoint !== null
          ? normalizeTrimmedValues([
              `Latest known-good checkpoint is turn ${latestReadyCheckpoint.checkpointTurnCount}.`,
              ...latestReadyCheckpoint.files.slice(0, 8).map((file) => `Touched ${file.path}`),
            ])
          : [],
      verifiedNotDone: normalizeTrimmedValues([
        input.reason,
        latestRelevantUserMessage &&
        latestRelevantUserMessage.id !== input.taskAnchor.authoritativeUserMessageId &&
        latestRelevantUserMessage.text.trim() !== input.taskAnchor.objective.trim()
          ? `Latest user input: ${truncateValue(latestRelevantUserMessage.text)}`
          : null,
      ]),
      nextAction:
        input.executionPolicy === "spawn_successor_thread"
          ? "Continue the same assignment in this successor thread. Treat this handoff as authoritative context."
          : "Continue from a fresh provider session on the same thread using the current repo state.",
      verificationStillRequired:
        latestCheckpoint?.status === "ready"
          ? ["Run the next verification pass after the fresh session picks up the thread."]
          : [
              "Checkpoint verification is incomplete. Re-check the working tree before broad edits.",
            ],
      relevantFilePaths,
      checkpointRef: latestReadyCheckpoint?.checkpointRef ?? null,
      executionPolicy: input.executionPolicy,
    };
  };

  const buildSuccessorOrdinal = (input: {
    readonly thread: OrchestrationThread;
    readonly threads: ReadonlyArray<OrchestrationThread>;
  }): number => {
    let ordinal = 1;
    let cursor = input.thread;
    const visited = new Set<ThreadId>([cursor.id]);
    while (cursor.homerSourceThreadId) {
      const sourceThread = input.threads.find((entry) => entry.id === cursor.homerSourceThreadId);
      if (!sourceThread || visited.has(sourceThread.id)) {
        break;
      }
      visited.add(sourceThread.id);
      ordinal += 1;
      cursor = sourceThread;
    }
    return ordinal + 1;
  };

  const buildSuccessorTitle = (input: {
    readonly thread: OrchestrationThread;
    readonly threads: ReadonlyArray<OrchestrationThread>;
  }) => {
    const baseTitle = stripHomerTitleSuffix(input.thread.title) || input.thread.title;
    const ordinal = buildSuccessorOrdinal(input);
    return `${baseTitle} (Homer ${ordinal})`;
  };

  const appendEscalationActivity = Effect.fn("appendEscalationActivity")(function* (input: {
    readonly threadId: ThreadId;
    readonly reason: string;
    readonly createdAt: string;
    readonly turnId: TurnId | null;
    readonly interventionCount: number;
  }) {
    yield* appendActivity({
      threadId: input.threadId,
      kind: T3_HOMER_ACTIVITY_KINDS.escalated,
      summary: "T3 Homer needs manual attention",
      tone: "error",
      turnId: input.turnId,
      createdAt: input.createdAt,
      payload: {
        reason: input.reason,
        interventionCount: input.interventionCount,
      },
    });
  });

  const markManualAttention = Effect.fn("markManualAttention")(function* (input: {
    readonly threadId: ThreadId;
    readonly createdAt: string;
    readonly executionPolicy: T3HomerExecutionPolicy;
  }) {
    yield* setManagedWorkState({
      threadId: input.threadId,
      state: {
        status: "manual_attention",
        executionPolicy: input.executionPolicy,
        activatedAt: input.createdAt,
        updatedAt: input.createdAt,
      },
    });
  });

  const stopThreadAuthority = Effect.fn("stopThreadAuthority")(function* (input: {
    readonly thread: OrchestrationThread;
    readonly reason: string;
    readonly createdAt: string;
    readonly interruptActiveTurn: boolean;
    readonly turnId: TurnId | null;
    readonly interventionCount: number;
  }) {
    const existingSession = input.thread.session;
    const stopKind = input.interruptActiveTurn
      ? T3_HOMER_ACTIVITY_KINDS.sessionInterrupted
      : T3_HOMER_ACTIVITY_KINDS.sessionEnded;
    const stopSummary = input.interruptActiveTurn
      ? "T3 Homer interrupted the current session"
      : "T3 Homer ended the current session";

    if (existingSession && existingSession.status !== "stopped") {
      yield* appendActivity({
        threadId: input.thread.id,
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
        providerService.stopSession({ threadId: input.thread.id }),
      );
      if (stopExit._tag === "Failure") {
        yield* appendEscalationActivity({
          threadId: input.thread.id,
          reason: truncateValue(Cause.pretty(stopExit.cause)),
          createdAt: input.createdAt,
          turnId: input.turnId,
          interventionCount: input.interventionCount,
        });
        return false;
      }
    }

    yield* setThreadSession({
      threadId: input.thread.id,
      session: {
        threadId: input.thread.id,
        status: "stopped",
        providerName: existingSession?.providerName ?? input.thread.modelSelection.provider,
        runtimeMode: existingSession?.runtimeMode ?? input.thread.runtimeMode,
        activeTurnId: null,
        lastError: existingSession?.lastError ?? null,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

    return true;
  });

  const restartInPlace = Effect.fn("restartInPlace")(function* (input: {
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
    const taskAnchor = yield* resolveTaskAnchor({
      thread,
      createdAt: input.createdAt,
    });

    const nextInterventionCount = state.interventionCount + 1;
    if (nextInterventionCount >= HOMER_ESCALATION_THRESHOLD) {
      state.supervisorState = "escalate";
      yield* appendEscalationActivity({
        threadId: input.threadId,
        reason: input.reason,
        createdAt: input.createdAt,
        turnId: input.turnId,
        interventionCount: nextInterventionCount,
      });
    }

    const stopped = yield* stopThreadAuthority({
      thread,
      reason: input.reason,
      createdAt: input.createdAt,
      interruptActiveTurn: input.interruptActiveTurn,
      turnId: input.turnId,
      interventionCount: nextInterventionCount,
    });
    if (!stopped) {
      yield* markManualAttention({
        threadId: input.threadId,
        createdAt: input.createdAt,
        executionPolicy: "restart_in_place",
      });
      state.interventionInProgress = false;
      return;
    }

    yield* appendActivity({
      threadId: input.threadId,
      kind: T3_HOMER_ACTIVITY_KINDS.handoffPrepared,
      summary: "T3 Homer prepared a fresh-session handoff",
      createdAt: input.createdAt,
      turnId: input.turnId,
      payload: buildHandoffPayload({
        thread,
        taskAnchor,
        reason: input.reason,
        executionPolicy: "restart_in_place",
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
        interventionCount: nextInterventionCount,
      });
      yield* markManualAttention({
        threadId: input.threadId,
        createdAt: input.createdAt,
        executionPolicy: "restart_in_place",
      });
      state.interventionInProgress = false;
      state.interventionCount = nextInterventionCount;
      state.lastIntervenedTurnId = input.turnId;
      return;
    }

    yield* setThreadSession({
      threadId: input.threadId,
      session: mapProviderSession(startExit.value),
      createdAt: input.createdAt,
    });
    yield* setManagedWorkState({
      threadId: input.threadId,
      state: {
        status: "active",
        executionPolicy: "restart_in_place",
        activatedAt: input.createdAt,
        updatedAt: input.createdAt,
      },
    });

    yield* appendActivity({
      threadId: input.threadId,
      kind: T3_HOMER_ACTIVITY_KINDS.sessionStarted,
      summary: "T3 Homer started a fresh session",
      createdAt: input.createdAt,
      turnId: null,
      payload: {
        reason: input.reason,
        provider: startExit.value.provider,
        executionPolicy: "restart_in_place",
        interventionCount: nextInterventionCount,
      },
    });

    state.warningCount = 0;
    state.errorCount = 0;
    state.interventionCount = nextInterventionCount;
    state.interventionInProgress = false;
    state.pendingReason = null;
    state.supervisorState = "continue";
    state.lastIntervenedTurnId = input.turnId;
  });

  const spawnSuccessorThread = Effect.fn("spawnSuccessorThread")(function* (input: {
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
    const taskAnchor = yield* resolveTaskAnchor({
      thread,
      createdAt: input.createdAt,
    });

    const nextInterventionCount = state.interventionCount + 1;
    if (nextInterventionCount >= HOMER_ESCALATION_THRESHOLD) {
      state.supervisorState = "escalate";
      yield* appendEscalationActivity({
        threadId: input.threadId,
        reason: input.reason,
        createdAt: input.createdAt,
        turnId: input.turnId,
        interventionCount: nextInterventionCount,
      });
    }

    const payload = buildHandoffPayload({
      thread,
      taskAnchor,
      reason: input.reason,
      executionPolicy: "spawn_successor_thread",
    });
    const successorThreadId = ThreadId.make(`thread:${crypto.randomUUID()}`);
    const successorTitle = buildSuccessorTitle({
      thread,
      threads: resolved.threads,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: serverCommandId("successor-thread-create"),
      threadId: successorThreadId,
      projectId: thread.projectId,
      title: successorTitle,
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      homerSourceThreadId: thread.id,
      homerSuccessorThreadId: null,
      homerTransitionKind: "spawn_successor_thread",
      homerTaskAnchor: taskAnchor,
      homerManagedWorkState: null,
      createdAt: input.createdAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: serverCommandId("successor-thread-link"),
      threadId: thread.id,
      homerSuccessorThreadId: successorThreadId,
      homerTransitionKind: "spawn_successor_thread",
      homerTaskAnchor: taskAnchor,
    });

    yield* appendActivity({
      threadId: thread.id,
      kind: T3_HOMER_ACTIVITY_KINDS.handoffPrepared,
      summary: "T3 Homer prepared a successor-thread handoff",
      createdAt: input.createdAt,
      turnId: input.turnId,
      payload,
    });

    yield* appendActivity({
      threadId: thread.id,
      kind: T3_HOMER_ACTIVITY_KINDS.successorThreadSpawned,
      summary: `T3 Homer spawned successor thread ${successorTitle}`,
      createdAt: input.createdAt,
      turnId: input.turnId,
      payload: {
        successorThreadId,
        successorThreadTitle: successorTitle,
        executionPolicy: "spawn_successor_thread",
      },
    });

    yield* appendActivity({
      threadId: successorThreadId,
      kind: T3_HOMER_ACTIVITY_KINDS.successorThreadCreated,
      summary: `T3 Homer created this thread from ${thread.title}`,
      createdAt: input.createdAt,
      payload: {
        sourceThreadId: thread.id,
        sourceThreadTitle: thread.title,
        executionPolicy: "spawn_successor_thread",
        handoff: payload,
      },
    });

    yield* appendSystemMessage({
      threadId: successorThreadId,
      text: `T3 Homer created this successor thread from "${thread.title}". The next user message is the authoritative handoff.`,
      createdAt: input.createdAt,
    });

    const stopped = yield* stopThreadAuthority({
      thread,
      reason: input.reason,
      createdAt: input.createdAt,
      interruptActiveTurn: input.interruptActiveTurn,
      turnId: input.turnId,
      interventionCount: nextInterventionCount,
    });
    if (!stopped) {
      yield* markManualAttention({
        threadId: thread.id,
        createdAt: input.createdAt,
        executionPolicy: "spawn_successor_thread",
      });
      state.interventionInProgress = false;
      return;
    }
    yield* setManagedWorkState({
      threadId: thread.id,
      state: null,
    });

    const successorThread = {
      ...thread,
      id: successorThreadId,
      title: successorTitle,
      homerSourceThreadId: thread.id,
      homerSuccessorThreadId: null,
      homerTransitionKind: "spawn_successor_thread" as const,
      homerTaskAnchor: taskAnchor,
      homerManagedWorkState: null,
      session: null,
    } satisfies OrchestrationThread;
    const successorCwd = resolveThreadWorkspaceCwd({
      thread: successorThread,
      projects: resolved.projects,
    });
    const startExit = yield* Effect.exit(
      providerService.startSession(successorThreadId, {
        threadId: successorThreadId,
        provider: successorThread.modelSelection.provider,
        ...(successorCwd ? { cwd: successorCwd } : {}),
        modelSelection: successorThread.modelSelection,
        runtimeMode: successorThread.runtimeMode,
      }),
    );
    if (startExit._tag === "Failure") {
      yield* appendEscalationActivity({
        threadId: successorThreadId,
        reason: truncateValue(Cause.pretty(startExit.cause)),
        createdAt: input.createdAt,
        turnId: null,
        interventionCount: nextInterventionCount,
      });
      yield* markManualAttention({
        threadId: successorThreadId,
        createdAt: input.createdAt,
        executionPolicy: "spawn_successor_thread",
      });
      state.interventionInProgress = false;
      state.interventionCount = nextInterventionCount;
      state.lastIntervenedTurnId = input.turnId;
      return;
    }

    yield* setThreadSession({
      threadId: successorThreadId,
      session: mapProviderSession(startExit.value),
      createdAt: input.createdAt,
    });
    yield* setManagedWorkState({
      threadId: successorThreadId,
      state: {
        status: "active",
        executionPolicy: "spawn_successor_thread",
        activatedAt: input.createdAt,
        updatedAt: input.createdAt,
      },
    });

    yield* appendActivity({
      threadId: successorThreadId,
      kind: T3_HOMER_ACTIVITY_KINDS.sessionStarted,
      summary: "T3 Homer started a fresh successor session",
      createdAt: input.createdAt,
      turnId: null,
      payload: {
        reason: input.reason,
        provider: startExit.value.provider,
        executionPolicy: "spawn_successor_thread",
        sourceThreadId: thread.id,
        interventionCount: nextInterventionCount,
      },
    });

    const handoffPrompt = buildSuccessorHandoffPrompt({
      sourceThread: thread,
      payload,
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: serverCommandId("successor-thread-turn-start"),
      threadId: successorThreadId,
      message: {
        messageId: MessageId.make(`t3homer:handoff:${crypto.randomUUID()}`),
        role: "user",
        text: handoffPrompt,
        attachments: [],
      },
      runtimeMode: successorThread.runtimeMode,
      interactionMode: successorThread.interactionMode,
      createdAt: input.createdAt,
    });

    state.warningCount = 0;
    state.errorCount = 0;
    state.interventionCount = nextInterventionCount;
    state.interventionInProgress = false;
    state.pendingReason = null;
    state.supervisorState = "continue";
    state.lastIntervenedTurnId = input.turnId;
  });

  const interveneOnThread = Effect.fn("interveneOnThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly reason: string;
    readonly createdAt: string;
    readonly interruptActiveTurn: boolean;
    readonly turnId: TurnId | null;
    readonly executionPolicy?: T3HomerExecutionPolicy;
  }) {
    const selectedPolicy = selectExecutionPolicy(input.threadId, input.executionPolicy);
    if (selectedPolicy === "spawn_successor_thread") {
      yield* spawnSuccessorThread({
        threadId: input.threadId,
        reason: input.reason,
        createdAt: input.createdAt,
        interruptActiveTurn: input.interruptActiveTurn,
        turnId: input.turnId,
      });
      return;
    }

    yield* restartInPlace({
      threadId: input.threadId,
      reason: input.reason,
      createdAt: input.createdAt,
      interruptActiveTurn: input.interruptActiveTurn,
      turnId: input.turnId,
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
      yield* interveneOnThread({
        threadId: input.threadId,
        reason: truncateValue(input.reason) || "Manual Homer test requested.",
        createdAt: input.createdAt,
        interruptActiveTurn: shouldInterruptActiveTurn,
        turnId: null,
        ...(input.executionPolicy ? { executionPolicy: input.executionPolicy } : {}),
      });

      return "triggered";
    },
  );

  const handleUserTurn: T3HomerSupervisorShape["handleUserTurn"] = Effect.fn("handleUserTurn")(
    function* (input) {
      if (!(yield* isEnabled)) {
        return "pass_through";
      }

      const resolved = yield* resolveThread(input.threadId);
      const thread = resolved.thread;
      if (!thread || thread.homerManagedWorkState === null) {
        return "pass_through";
      }

      if (!isStatusCheckMessage(input.text)) {
        yield* setManagedWorkState({
          threadId: input.threadId,
          state: null,
        });
        return "pass_through";
      }

      const managedState = thread.homerManagedWorkState;
      yield* appendActivity({
        threadId: input.threadId,
        kind: T3_HOMER_ACTIVITY_KINDS.statusCheckHandled,
        summary: "T3 Homer handled a status-check turn deterministically",
        createdAt: input.createdAt,
        tone: "info",
        payload: {
          statusCheckText: truncateValue(input.text, 120),
          managedStatus: managedState.status,
          executionPolicy: managedState.executionPolicy,
        },
      });

      if (managedState.status === "manual_attention") {
        yield* appendSystemMessage({
          threadId: input.threadId,
          text: "T3 Homer still requires manual attention before managed work can continue.",
          createdAt: input.createdAt,
        });
        yield* setManagedWorkState({
          threadId: input.threadId,
          state: {
            ...managedState,
            updatedAt: input.createdAt,
          },
        });
        return "handled";
      }

      if (thread.session?.status === "running" || thread.session?.activeTurnId !== null) {
        yield* appendSystemMessage({
          threadId: input.threadId,
          text: "T3 Homer is still managing this task and the current turn is still active.",
          createdAt: input.createdAt,
        });
        yield* setManagedWorkState({
          threadId: input.threadId,
          state: {
            ...managedState,
            updatedAt: input.createdAt,
          },
        });
        return "handled";
      }

      const taskAnchor =
        thread.homerTaskAnchor ??
        (yield* resolveTaskAnchor({
          thread,
          createdAt: input.createdAt,
        }));

      yield* appendSystemMessage({
        threadId: input.threadId,
        text: "T3 Homer is still managing this task. Resuming managed work now.",
        createdAt: input.createdAt,
      });
      yield* setManagedWorkState({
        threadId: input.threadId,
        state: {
          ...managedState,
          updatedAt: input.createdAt,
        },
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: serverCommandId("managed-work-resume"),
        threadId: input.threadId,
        message: {
          messageId: MessageId.make(`t3homer:managed-resume:${crypto.randomUUID()}`),
          role: "user",
          text: buildManagedContinuationPrompt({
            thread,
            taskAnchor,
            executionPolicy: managedState.executionPolicy,
            statusCheckText: input.text,
          }),
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: input.createdAt,
      });

      return "handled";
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
      yield* interveneOnThread({
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
      summary: "T3 Homer is preparing a handoff",
      createdAt: input.createdAt,
      turnId: input.turnId,
      payload: {
        reason: input.reason,
        ...(input.usageRatio !== undefined ? { usageRatio: input.usageRatio } : {}),
      },
    });
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
        yield* interveneOnThread({
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
        yield* interveneOnThread({
          threadId: event.threadId,
          reason: "Provider compacted the thread state, so Homer rotated to a fresh continuation.",
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
        yield* interveneOnThread({
          threadId: event.threadId,
          reason: state.pendingReason ?? "T3 Homer requested a clean handoff.",
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
    handleUserTurn,
    forceHandoff,
  } satisfies T3HomerSupervisorShape;
});

export const T3HomerSupervisorLive = Layer.effect(T3HomerSupervisor, make);
