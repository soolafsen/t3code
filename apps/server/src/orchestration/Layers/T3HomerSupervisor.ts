import {
  CheckpointRef,
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
  type T3HomerInstructionDeltaSnapshot,
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
const HOMER_RESTART_FAILURE_PROMOTION_THRESHOLD = 2;
const HOMER_RUNTIME_FATAL_REPEAT_THRESHOLD = 2;
const HOMER_PENDING_TURN_TIMEOUT_MS = 20_000;
const HOMER_GOAL_MAX_CHARS = 220;
const HOMER_DETAIL_MAX_CHARS = 180;
const HOMER_TITLE_SUFFIX_RE = /\s+\(Homer \d+\)$/;
const HOMER_SECTION_HEADER_RE = /^\s*([A-Za-z][A-Za-z\s/-]+):\s*$/;
const HOMER_MANAGED_FOLLOW_UP_MAX_CHARS = 200;
const HOMER_INSTRUCTION_DELTA_MESSAGE_LIMIT = 5;
const HOMER_INSTRUCTION_DELTA_ENTRY_LIMIT = 3;
const HOMER_OBJECTIVE_URL_ONLY_RE = /^https?:\/\/\S+$/i;
const HOMER_OBJECTIVE_READ_AND_IMPLEMENT_URL_RE =
  /^read this and implement it:\s*(https?:\/\/\S+)$/i;
const HOMER_OBJECTIVE_ACK_ONLY_RE =
  /^(?:ok|okay|thanks|thank you|thx|good|great|nice|cool|perfect|sounds good|got it|yep|yes|no)\.?$/i;
const HOMER_OBJECTIVE_PREFIX_RE =
  /^(?:please\s+)?(?:can you\s+)?(?:could you\s+)?(?:i want you to\s+)?(?:you need to\s+)?/i;
const HOMER_OBJECTIVE_ACTION_HINT_RE =
  /\b(?:implement|fix|update|change|add|remove|refactor|rewrite|rename|adjust|improve|test|verify|check|run|use|create|delete|move|stack|align|patch)\b/i;
const HOMER_OBJECTIVE_MIN_CHARS = 24;
const HOMER_STATUS_CHECK_PATTERNS = [
  /^(?:are you still working|are you still working on (?:the )?tasks|still working|status|status update|progress|progress update|working on (?:the )?tasks)\??$/i,
] as const;
const HOMER_RESUME_MANAGED_WORK_PATTERNS = [
  /^(?:continue|continue from here|continue where you left off|keep going|keep working|resume|resume from here|resume where you left off|pick up where you left off)\.?$/i,
  /^(?:finish (?:it|the task|the tasks|the remaining tasks|the remaining work))\.?$/i,
  /^(?:look at|check|review) (?:your|the) tasks\.?$/i,
] as const;
const HOMER_COMPLETION_CHECK_PATTERNS = [
  /^(?:are you done|are you finished|are you complete|done|finished|complete)\??$/i,
  /^(?:what remains|what's left|what is left|anything left|what remains on (?:the )?tasks)\??$/i,
] as const;

type HomerManagedFollowUpKind =
  | "status_check"
  | "resume_managed_work"
  | "completion_check"
  | "user_takes_back_control";

type SupervisorDomainEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.turn-start-requested"
      | "thread.turn-diff-completed"
      | "thread.turn-interrupt-requested"
      | "thread.session-stop-requested";
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

type HomerPromotionTriggerKind =
  | "repeated_restart_failure"
  | "pending_turn_timeout"
  | "runtime_fatal_repeat"
  | "manual";

type HomerEscalationEvidence = {
  triggerKind: HomerPromotionTriggerKind;
  attemptCount: number;
  assignmentRevision: number;
  lastKnownTurnId: TurnId | null;
  checkpointRef: CheckpointRef | null;
};

type HomerPolicyDecision = {
  executionPolicy: T3HomerExecutionPolicy;
  escalation: HomerEscalationEvidence | null;
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
  suppressInterventionUntilNextTurnStart: boolean;
  lastAuthoritativeAssignmentRevision: number | null;
  restartAttemptsForRevision: number;
  lastSuccessfulCompletedTurnAtForRevision: string | null;
  pendingTurnRequestedAt: string | null;
  runtimeFatalCountInManagedWindow: number;
  lastKnownTurnId: TurnId | null;
  lastKnownCheckpointRef: CheckpointRef | null;
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
    suppressInterventionUntilNextTurnStart: false,
    lastAuthoritativeAssignmentRevision: null,
    restartAttemptsForRevision: 0,
    lastSuccessfulCompletedTurnAtForRevision: null,
    pendingTurnRequestedAt: null,
    runtimeFatalCountInManagedWindow: 0,
    lastKnownTurnId: null,
    lastKnownCheckpointRef: null,
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

function toEpochMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getAssignmentRevision(thread: OrchestrationThread, state: HomerState): number {
  return thread.homerTaskAnchor?.revision ?? state.lastAuthoritativeAssignmentRevision ?? 1;
}

function syncRevisionTracking(state: HomerState, assignmentRevision: number): void {
  if (state.lastAuthoritativeAssignmentRevision === assignmentRevision) {
    return;
  }
  state.lastAuthoritativeAssignmentRevision = assignmentRevision;
  state.restartAttemptsForRevision = 0;
  state.lastSuccessfulCompletedTurnAtForRevision = null;
  state.runtimeFatalCountInManagedWindow = 0;
}

function hasPendingTurnTimedOut(state: HomerState, createdAt: string): boolean {
  const requestedAt = toEpochMs(state.pendingTurnRequestedAt);
  const now = toEpochMs(createdAt);
  if (requestedAt === null || now === null) {
    return false;
  }
  return now - requestedAt >= HOMER_PENDING_TURN_TIMEOUT_MS;
}

function buildEscalationEvidence(
  state: HomerState,
  input: {
    readonly triggerKind: HomerPromotionTriggerKind;
    readonly assignmentRevision: number;
  },
): HomerEscalationEvidence {
  return {
    triggerKind: input.triggerKind,
    attemptCount: state.restartAttemptsForRevision,
    assignmentRevision: input.assignmentRevision,
    lastKnownTurnId: state.lastKnownTurnId,
    checkpointRef: state.lastKnownCheckpointRef,
  };
}

function hasHandledTurn(state: HomerState, turnId: TurnId | null): boolean {
  return turnId !== null && state.lastIntervenedTurnId === turnId;
}

function stripHomerTitleSuffix(title: string): string {
  return title.replace(HOMER_TITLE_SUFFIX_RE, "").trim();
}

function areStringArraysEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeMessageText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function normalizeInstructionLine(line: string): string {
  return line.trim().replace(/^[-*]\s+/, "");
}

function truncateInstructionDelta(value: string): string {
  return truncateValue(value, HOMER_DETAIL_MAX_CHARS);
}

function renderManagedFollowUpSummary(
  followUpKind: HomerManagedFollowUpKind,
  followUpText: string,
): string {
  switch (followUpKind) {
    case "status_check":
      return "Short status check from user.";
    case "completion_check":
      return "Short completion check from user.";
    case "resume_managed_work":
      return truncateValue(followUpText, 120);
    case "user_takes_back_control":
      return "User took back control.";
  }
}

function matchesManagedFollowUpPattern(text: string, patterns: ReadonlyArray<RegExp>): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function classifyManagedFollowUpMessage(text: string): HomerManagedFollowUpKind {
  const trimmed = text.trim();
  const normalized = normalizeMessageText(text);
  if (trimmed.length === 0) {
    return "user_takes_back_control";
  }
  if (
    trimmed.length > HOMER_MANAGED_FOLLOW_UP_MAX_CHARS ||
    trimmed.includes("\n") ||
    trimmed.includes("\r") ||
    trimmed.includes("```")
  ) {
    return "user_takes_back_control";
  }
  if (matchesManagedFollowUpPattern(normalized, HOMER_COMPLETION_CHECK_PATTERNS)) {
    return "completion_check";
  }
  if (matchesManagedFollowUpPattern(normalized, HOMER_RESUME_MANAGED_WORK_PATTERNS)) {
    return "resume_managed_work";
  }
  if (matchesManagedFollowUpPattern(normalized, HOMER_STATUS_CHECK_PATTERNS)) {
    return "status_check";
  }
  return "user_takes_back_control";
}

function isManagedFollowUpMessage(text: string): boolean {
  return classifyManagedFollowUpMessage(text) !== "user_takes_back_control";
}

function extractRequiredExactCompletionPhrase(text: string): string | null {
  const matches = Array.from(
    text.matchAll(/\b(?:say|reply|respond|output)\s+exactly\s+(?:`([^`]+)`|"([^"]+)"|'([^']+)')/gi),
  );
  const latestMatch = matches.at(-1);
  if (!latestMatch) {
    return null;
  }
  const phrase = latestMatch[1] ?? latestMatch[2] ?? latestMatch[3] ?? null;
  const normalized = phrase?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function extractCompletionChecks(
  text: string,
  requiredExactCompletionPhrase: string | null,
): string[] {
  const matchingLines = normalizeTrimmedValues(
    text
      .split(/\r?\n/)
      .map(normalizeInstructionLine)
      .filter(
        (line) =>
          line.length > 0 &&
          /(?:\b(?:say|reply|respond|output)\s+exactly\b|\bwhen\b.*\bcomplete\b|\bonly\b.*\bcomplete\b|\bdo not\b.*\buntil\b.*\bcomplete\b)/i.test(
            line,
          ),
      ),
  );
  if (matchingLines.length > 0) {
    return matchingLines;
  }
  if (requiredExactCompletionPhrase === null) {
    return [];
  }
  return [
    "Only emit the required exact completion phrase when the authoritative assignment is genuinely complete.",
    "Do not emit the required exact completion phrase for status updates or partial completion.",
  ];
}

function buildCompletionContractLines(taskAnchor: T3HomerTaskAnchor): string[] {
  return [
    "Completion contract:",
    `Required exact completion phrase: ${taskAnchor.requiredExactCompletionPhrase ?? "none recorded."}`,
    "Completion checks:",
    ...(taskAnchor.completionChecks.length > 0
      ? taskAnchor.completionChecks.map((entry) => `- ${entry}`)
      : ["- None recorded."]),
  ];
}

function buildExecutionDirectiveLines(): string[] {
  return [
    "Execution directives:",
    "- Implement the assignment directly in repository files now.",
    "- Do not create TODO, plan, or handoff documents unless explicitly requested.",
    "- Keep scope minimal and avoid unrelated architecture changes.",
    "- Run required checks/tests and report concrete pass/fail outcomes.",
  ];
}

function isHomerInjectedUserMessage(text: string): boolean {
  return (
    text.startsWith("T3 Homer successor-thread handoff.") ||
    text.startsWith("T3 Homer managed-work continuation.")
  );
}

function formatLatestCheckpointStatus(thread: OrchestrationThread): string {
  const latestCheckpoint = thread.checkpoints.at(-1);
  if (!latestCheckpoint) {
    return "none recorded yet";
  }
  return `${latestCheckpoint.status} (turn ${latestCheckpoint.checkpointTurnCount})`;
}

function buildPreflightGuardLines(input: {
  readonly thread: OrchestrationThread;
  readonly taskAnchor: T3HomerTaskAnchor;
}): string[] {
  const latestCheckpoint = input.thread.checkpoints.at(-1);
  const checkpointStatus = latestCheckpoint?.status ?? null;

  return [
    "Preflight guards:",
    `- Expected branch: ${input.taskAnchor.branchExpectation ?? "current branch context"}. Confirm before edits.`,
    `- Latest checkpoint status: ${formatLatestCheckpointStatus(input.thread)}.`,
    checkpointStatus === "ready"
      ? "- Completion gate: only claim completion when repository state and checkpoint evidence still agree."
      : "- Completion gate: do not claim full completion while latest checkpoint is missing/error/unset.",
  ];
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

function extractConstraints(messages: ReadonlyArray<OrchestrationMessage>): string[] {
  return normalizeTrimmedValues(
    messages.flatMap((message) =>
      extractSectionEntries(message.text, ["Constraints", "Constraint"]),
    ),
  );
}

function extractNonGoals(messages: ReadonlyArray<OrchestrationMessage>): string[] {
  return normalizeTrimmedValues(
    messages.flatMap((message) =>
      extractSectionEntries(message.text, ["Non-goals", "Non-goal", "Non goals"]),
    ),
  );
}

function extractActionableObjectiveFromMessage(text: string): string | null {
  const firstNonEmptyLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  const normalizedLine = normalizeMessageText(firstNonEmptyLine);
  if (normalizedLine.length === 0 || HOMER_OBJECTIVE_ACK_ONLY_RE.test(normalizedLine)) {
    return null;
  }
  const cleanedLine = normalizedLine.replace(HOMER_OBJECTIVE_PREFIX_RE, "").trim();
  if (cleanedLine.length === 0) {
    return null;
  }

  const messageHasSourceDocs = extractSourceDocumentPaths(text).length > 0;
  const looksActionable =
    cleanedLine.length >= HOMER_OBJECTIVE_MIN_CHARS ||
    HOMER_OBJECTIVE_ACTION_HINT_RE.test(cleanedLine) ||
    messageHasSourceDocs ||
    HOMER_OBJECTIVE_URL_ONLY_RE.test(cleanedLine);
  if (!looksActionable) {
    return null;
  }

  return truncateValue(cleanedLine, HOMER_GOAL_MAX_CHARS);
}

function extractObjectiveFromMessages(
  messages: ReadonlyArray<OrchestrationMessage>,
  fallback: string,
): string {
  for (const message of messages.toReversed()) {
    const readAndImplementMatch = message.text.match(
      /^\s*(?:read this and implement it|implement this):\s*(.+)$/im,
    );
    if (readAndImplementMatch?.[1]) {
      const objective = truncateValue(readAndImplementMatch[0], HOMER_GOAL_MAX_CHARS);
      if (objective.length > 0) {
        return objective;
      }
    }

    const explicitTaskMatch = message.text.match(/^\s*Your task is\s+(.+)$/im);
    if (explicitTaskMatch?.[1]) {
      const objective = truncateValue(explicitTaskMatch[1], HOMER_GOAL_MAX_CHARS);
      if (objective.length > 0) {
        return objective;
      }
    }

    const goalEntries = extractSectionEntries(message.text, ["Goal"]);
    if (goalEntries.length > 0) {
      const objective = truncateValue(goalEntries.join(" "), HOMER_GOAL_MAX_CHARS);
      if (objective.length > 0) {
        return objective;
      }
    }

    const inferredObjective = extractActionableObjectiveFromMessage(message.text);
    if (inferredObjective !== null) {
      return inferredObjective;
    }
  }

  return fallback;
}

function normalizeObjectiveForExecution(
  objective: string,
  sourceDocumentPaths: ReadonlyArray<string>,
): string {
  const trimmed = objective.trim();
  const readAndImplementUrlMatch = trimmed.match(HOMER_OBJECTIVE_READ_AND_IMPLEMENT_URL_RE);
  const urlOnlyObjective = HOMER_OBJECTIVE_URL_ONLY_RE.test(trimmed) ? trimmed : null;
  const normalizedDocReference = readAndImplementUrlMatch?.[1] ?? urlOnlyObjective;
  if (normalizedDocReference !== null && normalizedDocReference.trim().length > 0) {
    return truncateValue(
      `Implement the tasks defined in ${normalizedDocReference} in this repository.`,
      HOMER_GOAL_MAX_CHARS,
    );
  }
  if (trimmed.length > 0) {
    return truncateValue(trimmed, HOMER_GOAL_MAX_CHARS);
  }
  const fallbackDoc = sourceDocumentPaths.at(0);
  if (fallbackDoc) {
    return truncateValue(
      `Implement the tasks defined in ${fallbackDoc} in this repository.`,
      HOMER_GOAL_MAX_CHARS,
    );
  }
  return trimmed;
}

function extractInstructionDeltasFromMessage(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const deltas: string[] = [];
  let activeSection: "constraints" | "non_goals" | "other" | null = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) {
      activeSection = null;
      continue;
    }

    const headerMatch = trimmed.match(HOMER_SECTION_HEADER_RE);
    if (headerMatch) {
      const label = headerMatch[1]!.trim().toLowerCase();
      activeSection =
        label === "constraints" || label === "constraint"
          ? "constraints"
          : label === "non-goals" || label === "non-goal" || label === "non goals"
            ? "non_goals"
            : "other";
      continue;
    }

    const normalized = normalizeInstructionLine(trimmed);
    if (normalized.length === 0) {
      continue;
    }
    if (/^(?:docs|apps|packages)\//i.test(normalized) || /^https?:\/\//i.test(normalized)) {
      continue;
    }
    if (/^(?:your task is|goal:)/i.test(normalized)) {
      continue;
    }

    if (activeSection === "constraints") {
      deltas.push(`Constraint: ${normalized}`);
      continue;
    }
    if (activeSection === "non_goals") {
      deltas.push(`Non-goal: ${normalized}`);
      continue;
    }
    if (
      /^(?:read|start by reading|use|keep|avoid|work|implement|fix|preserve|carry|continue|do not|don't|never)\b/i.test(
        normalized,
      )
    ) {
      deltas.push(normalized);
      continue;
    }
    if (/(?:\bexactly\b|\bcomplete\b|\bcompletion\b)/i.test(normalized)) {
      deltas.push(normalized);
    }
  }

  return normalizeTrimmedValues(deltas.map(truncateInstructionDelta));
}

function buildInstructionDeltaSnapshot(input: {
  readonly authoritativeMessages: ReadonlyArray<OrchestrationMessage>;
  readonly revision: number;
  readonly createdAt: string;
}): T3HomerInstructionDeltaSnapshot {
  const recentMessages = input.authoritativeMessages.slice(-HOMER_INSTRUCTION_DELTA_MESSAGE_LIMIT);
  const instructionDeltas = normalizeTrimmedValues(
    recentMessages.flatMap((message) => extractInstructionDeltasFromMessage(message.text)),
  ).slice(-HOMER_INSTRUCTION_DELTA_ENTRY_LIMIT);

  return {
    instructionDeltas,
    snapshotRevision: input.revision,
    createdAt: input.createdAt,
  };
}

function getUserMessages(thread: OrchestrationThread): OrchestrationMessage[] {
  return thread.messages.filter((message) => message.role === "user");
}

function getAuthoritativeUserMessages(thread: OrchestrationThread): OrchestrationMessage[] {
  const userMessages = getUserMessages(thread);
  const informativeMessages = userMessages.filter(
    (message) => !HOMER_OBJECTIVE_ACK_ONLY_RE.test(normalizeMessageText(message.text)),
  );
  const nonSyntheticMessages = informativeMessages.filter(
    (message) =>
      !isManagedFollowUpMessage(message.text) && !isHomerInjectedUserMessage(message.text),
  );
  if (nonSyntheticMessages.length > 0) {
    return nonSyntheticMessages;
  }
  const nonManagedMessages = informativeMessages.filter(
    (message) => !isManagedFollowUpMessage(message.text),
  );
  return nonManagedMessages.length > 0 ? nonManagedMessages : userMessages;
}

function collectObservedThreadState(input: {
  readonly thread: OrchestrationThread;
  readonly taskAnchor: T3HomerTaskAnchor;
  readonly reason?: string;
}) {
  const latestRelevantUserMessage =
    getUserMessages(input.thread)
      .toReversed()
      .find(
        (message) =>
          !isManagedFollowUpMessage(message.text) &&
          !isHomerInjectedUserMessage(message.text) &&
          message.id !== input.taskAnchor.authoritativeUserMessageId &&
          normalizeMessageText(message.text) !== normalizeMessageText(input.taskAnchor.objective),
      ) ?? null;
  const latestReadyCheckpoint = input.thread.checkpoints
    .toReversed()
    .find((checkpoint) => checkpoint.status === "ready");
  const latestCheckpoint = input.thread.checkpoints.at(-1) ?? null;
  const relevantCheckpoint = latestReadyCheckpoint ?? latestCheckpoint ?? null;
  const latestCheckpointStatus = latestCheckpoint?.status ?? null;
  const latestDifferingInput = latestRelevantUserMessage
    ? truncateValue(normalizeMessageText(latestRelevantUserMessage.text), 140)
    : null;

  return {
    verifiedDone:
      latestReadyCheckpoint !== undefined && latestReadyCheckpoint !== null
        ? normalizeTrimmedValues([
            `Latest known-good checkpoint is turn ${latestReadyCheckpoint.checkpointTurnCount}.`,
            ...latestReadyCheckpoint.files.slice(0, 8).map((file) => `Touched ${file.path}`),
          ])
        : [],
    verifiedNotDone: normalizeTrimmedValues([
      input.reason ?? null,
      latestRelevantUserMessage
        ? `Latest real user input differs from authoritative assignment (message ${latestRelevantUserMessage.id}).`
        : null,
      latestDifferingInput ? `Latest differing user input: ${latestDifferingInput}` : null,
      latestCheckpoint !== null && latestCheckpoint.status !== "ready"
        ? `Checkpoint state is ${latestCheckpoint.status} after the last turn.`
        : null,
    ]),
    verificationStillRequired:
      latestCheckpointStatus === "ready"
        ? ["Run the next verification pass after the fresh session picks up the thread."]
        : latestCheckpointStatus === "missing"
          ? [
              "Latest checkpoint status is missing. Treat completion as unverified and continue from the current repository state.",
            ]
          : latestCheckpointStatus === "error"
            ? [
                "Latest checkpoint status is error. Treat completion as unverified until checkpoint capture succeeds.",
              ]
            : [
                "Checkpoint verification is incomplete. Re-check the working tree before broad edits.",
              ],
    relevantFilePaths: normalizeTrimmedValues(
      relevantCheckpoint?.files.slice(0, 12).map((file) => file.path) ?? [],
    ),
    checkpointRef: relevantCheckpoint?.checkpointRef ?? null,
  };
}

function buildSuccessorHandoffPrompt(input: {
  readonly sourceThread: OrchestrationThread;
  readonly payload: T3HomerHandoffPayload;
}) {
  const { taskAnchor } = input.payload;
  const executableObjective = normalizeObjectiveForExecution(
    taskAnchor.objective,
    taskAnchor.sourceDocumentPaths,
  );
  const instructionDeltaSnapshot =
    taskAnchor.instructionDeltaSnapshot ?? input.payload.instructionDeltaSnapshot;
  const sections = [
    "T3 Homer successor-thread handoff.",
    "",
    `Source thread: ${input.payload.sourceThreadId}`,
    `Source title: ${input.sourceThread.title}`,
    `Execution policy: ${input.payload.executionPolicy}`,
    "",
    "Authoritative assignment:",
    `Objective: ${executableObjective}`,
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
    `Assignment revision: ${taskAnchor.revision}`,
    "",
    "Recent instruction deltas:",
    ...(instructionDeltaSnapshot.instructionDeltas.length > 0
      ? instructionDeltaSnapshot.instructionDeltas.map((entry) => `- ${entry}`)
      : ["- None recorded."]),
    "",
    `Branch expectation: ${taskAnchor.branchExpectation ?? "current branch context"}`,
    "",
    ...buildCompletionContractLines(taskAnchor),
    "",
    "Continuity rules:",
    "- This assignment remains authoritative until the user explicitly changes it.",
    "- Treat short status checks, completion questions, and continue nudges as managed continuation, not as new assignments.",
    "- Do not ask what the original assignment was.",
    "",
    ...buildPreflightGuardLines({
      thread: input.sourceThread,
      taskAnchor,
    }),
    "",
    ...buildExecutionDirectiveLines(),
    "",
    `Goal: ${executableObjective}`,
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
  readonly followUpText: string;
  readonly followUpKind: HomerManagedFollowUpKind;
}) {
  const observed = collectObservedThreadState({
    thread: input.thread,
    taskAnchor: input.taskAnchor,
  });
  const executableObjective = normalizeObjectiveForExecution(
    input.taskAnchor.objective,
    input.taskAnchor.sourceDocumentPaths,
  );
  const instructionDeltaSnapshot = input.taskAnchor.instructionDeltaSnapshot;
  const followUpSummary = renderManagedFollowUpSummary(input.followUpKind, input.followUpText);
  const sections = [
    "T3 Homer managed-work continuation.",
    "",
    `Thread: ${input.thread.id}`,
    `Execution policy: ${input.executionPolicy}`,
    `Managed follow-up kind: ${input.followUpKind}`,
    `Managed follow-up received: ${followUpSummary}`,
    "",
    "Authority rules:",
    "- This managed follow-up does not change the assignment.",
    "- Continue the existing authoritative task until the user gives a real new instruction.",
    "- If the task is not complete, continue working or report what remains without claiming completion.",
    "",
    ...buildPreflightGuardLines({
      thread: input.thread,
      taskAnchor: input.taskAnchor,
    }),
    "",
    ...buildExecutionDirectiveLines(),
    "",
    `Objective: ${executableObjective}`,
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
    `Assignment revision: ${input.taskAnchor.revision}`,
    "",
    "Recent instruction deltas:",
    ...(instructionDeltaSnapshot && instructionDeltaSnapshot.instructionDeltas.length > 0
      ? instructionDeltaSnapshot.instructionDeltas.map((entry) => `- ${entry}`)
      : ["- None recorded."]),
    "",
    `Branch expectation: ${input.taskAnchor.branchExpectation ?? "current branch context"}`,
    "",
    ...buildCompletionContractLines(input.taskAnchor),
    "",
    "Observed state:",
    ...(observed.verifiedDone.length > 0
      ? observed.verifiedDone.map((entry) => `- ${entry}`)
      : ["- No verified completed checkpoint is recorded on this thread yet."]),
    "",
    "Observed not done:",
    ...(observed.verifiedNotDone.length > 0
      ? observed.verifiedNotDone.map((entry) => `- ${entry}`)
      : ["- No extra unfinished observations recorded."]),
    "",
    "Verification still required:",
    ...observed.verificationStillRequired.map((entry) => `- ${entry}`),
    "",
    `Checkpoint ref: ${observed.checkpointRef ?? "none"}`,
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

  const isManagedWorkActive = Effect.fn("isManagedWorkActive")(function* (threadId: ThreadId) {
    const resolved = yield* resolveThread(threadId);
    return resolved.thread?.homerManagedWorkState !== null;
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

  const appendAssignmentRevisionUpdatedActivity = Effect.fn(
    "appendAssignmentRevisionUpdatedActivity",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly previousRevision: number | null;
    readonly nextRevision: number;
    readonly authoritativeUserMessageId: MessageId | null;
    readonly createdAt: string;
    readonly turnId?: TurnId | null;
  }) {
    yield* appendActivity({
      threadId: input.threadId,
      kind: T3_HOMER_ACTIVITY_KINDS.assignmentRevisionUpdated,
      summary:
        input.previousRevision === null
          ? `T3 Homer set authoritative assignment revision ${input.nextRevision}`
          : `T3 Homer updated authoritative assignment revision ${input.previousRevision} -> ${input.nextRevision}`,
      createdAt: input.createdAt,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      payload: {
        previousRevision: input.previousRevision,
        nextRevision: input.nextRevision,
        authoritativeUserMessageId: input.authoritativeUserMessageId,
      },
    });
  });

  const appendInstructionSnapshotWrittenActivity = Effect.fn(
    "appendInstructionSnapshotWrittenActivity",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly snapshot: T3HomerInstructionDeltaSnapshot;
    readonly createdAt: string;
    readonly turnId?: TurnId | null;
  }) {
    yield* appendActivity({
      threadId: input.threadId,
      kind: T3_HOMER_ACTIVITY_KINDS.instructionSnapshotWritten,
      summary: `T3 Homer wrote instruction snapshot r${input.snapshot.snapshotRevision} (${input.snapshot.instructionDeltas.length} delta${input.snapshot.instructionDeltas.length === 1 ? "" : "s"})`,
      createdAt: input.createdAt,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      payload: {
        snapshotRevision: input.snapshot.snapshotRevision,
        instructionDeltas: input.snapshot.instructionDeltas,
        createdAt: input.snapshot.createdAt,
      },
    });
  });

  const appendContinuityPromptConsumedActivity = Effect.fn(
    "appendContinuityPromptConsumedActivity",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly promptKind: "managed_continuation" | "successor_handoff";
    readonly executionPolicy: T3HomerExecutionPolicy;
    readonly revision: number;
    readonly snapshotRevision: number;
    readonly createdAt: string;
    readonly turnId?: TurnId | null;
  }) {
    yield* appendActivity({
      threadId: input.threadId,
      kind: T3_HOMER_ACTIVITY_KINDS.continuityPromptConsumed,
      summary:
        input.promptKind === "managed_continuation"
          ? "T3 Homer injected managed continuation prompt"
          : "T3 Homer injected successor handoff prompt",
      createdAt: input.createdAt,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      payload: {
        promptKind: input.promptKind,
        executionPolicy: input.executionPolicy,
        revision: input.revision,
        snapshotRevision: input.snapshotRevision,
      },
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

  const releaseManagedAuthorityForExplicitStop = Effect.fn(
    "releaseManagedAuthorityForExplicitStop",
  )(function* (input: { readonly threadId: ThreadId }) {
    const resolved = yield* resolveThread(input.threadId);
    if (resolved.thread?.homerManagedWorkState === null || resolved.thread === null) {
      return;
    }
    yield* setManagedWorkState({
      threadId: input.threadId,
      state: null,
    });
  });

  const selectExecutionPolicy = (input: {
    readonly thread: OrchestrationThread;
    readonly createdAt: string;
    readonly explicitPolicy?: T3HomerExecutionPolicy;
    readonly allowPendingTimeoutPromotion?: boolean;
  }): HomerPolicyDecision => {
    const state = getState(input.thread.id);
    const assignmentRevision = getAssignmentRevision(input.thread, state);
    syncRevisionTracking(state, assignmentRevision);

    if (input.explicitPolicy === "spawn_successor_thread") {
      return {
        executionPolicy: "spawn_successor_thread",
        escalation: buildEscalationEvidence(state, {
          triggerKind: "manual",
          assignmentRevision,
        }),
      };
    }
    if (input.explicitPolicy === "restart_in_place") {
      return {
        executionPolicy: "restart_in_place",
        escalation: null,
      };
    }

    if (
      input.allowPendingTimeoutPromotion === true &&
      hasPendingTurnTimedOut(state, input.createdAt)
    ) {
      return {
        executionPolicy: "spawn_successor_thread",
        escalation: buildEscalationEvidence(state, {
          triggerKind: "pending_turn_timeout",
          assignmentRevision,
        }),
      };
    }

    const inManagedWindow = input.thread.homerManagedWorkState !== null;
    if (!inManagedWindow) {
      return {
        executionPolicy: "restart_in_place",
        escalation: null,
      };
    }

    if (state.runtimeFatalCountInManagedWindow >= HOMER_RUNTIME_FATAL_REPEAT_THRESHOLD) {
      return {
        executionPolicy: "spawn_successor_thread",
        escalation: buildEscalationEvidence(state, {
          triggerKind: "runtime_fatal_repeat",
          assignmentRevision,
        }),
      };
    }
    if (state.restartAttemptsForRevision >= HOMER_RESTART_FAILURE_PROMOTION_THRESHOLD) {
      return {
        executionPolicy: "spawn_successor_thread",
        escalation: buildEscalationEvidence(state, {
          triggerKind: "repeated_restart_failure",
          assignmentRevision,
        }),
      };
    }

    return {
      executionPolicy: "restart_in_place",
      escalation: null,
    };
  };

  const resolveTaskAnchor = Effect.fn("resolveTaskAnchor")(function* (input: {
    readonly thread: OrchestrationThread;
    readonly createdAt: string;
    readonly refreshSnapshotBeforeTransition?: boolean;
    readonly turnId?: TurnId | null;
  }) {
    const authoritativeMessages = getAuthoritativeUserMessages(input.thread);
    const latestAuthoritativeMessage = authoritativeMessages.at(-1) ?? null;
    const allRelevantText = authoritativeMessages.map((message) => message.text).join("\n\n");
    const requiredExactCompletionPhrase = extractRequiredExactCompletionPhrase(allRelevantText);
    const completionChecks = extractCompletionChecks(
      allRelevantText,
      requiredExactCompletionPhrase,
    );
    const existingTaskAnchor = input.thread.homerTaskAnchor;
    const sourceDocumentPaths = extractSourceDocumentPaths(allRelevantText);
    const objective = normalizeObjectiveForExecution(
      extractObjectiveFromMessages(
        authoritativeMessages,
        existingTaskAnchor?.objective ?? input.thread.title,
      ),
      sourceDocumentPaths,
    );
    const constraints = extractConstraints(authoritativeMessages);
    const nonGoals = extractNonGoals(authoritativeMessages);
    const branchExpectation = input.thread.branch;
    const derivedRevisionFloor = Math.max(authoritativeMessages.length, 1);
    const nextRevision = Math.max(existingTaskAnchor?.revision ?? 1, derivedRevisionFloor);
    const instructionDeltaSnapshot = buildInstructionDeltaSnapshot({
      authoritativeMessages,
      revision: nextRevision,
      createdAt: input.createdAt,
    });

    if (existingTaskAnchor) {
      const instructionChangesDetected =
        existingTaskAnchor.objective !== objective ||
        !areStringArraysEqual(existingTaskAnchor.sourceDocumentPaths, sourceDocumentPaths) ||
        !areStringArraysEqual(existingTaskAnchor.constraints, constraints) ||
        !areStringArraysEqual(existingTaskAnchor.nonGoals, nonGoals) ||
        existingTaskAnchor.requiredExactCompletionPhrase !== requiredExactCompletionPhrase ||
        !areStringArraysEqual(existingTaskAnchor.completionChecks, completionChecks) ||
        !areStringArraysEqual(
          existingTaskAnchor.instructionDeltaSnapshot?.instructionDeltas ?? [],
          instructionDeltaSnapshot.instructionDeltas,
        );
      const branchExpectationChanged = existingTaskAnchor.branchExpectation !== branchExpectation;

      const revision = instructionChangesDetected
        ? Math.max(existingTaskAnchor.revision + 1, derivedRevisionFloor)
        : existingTaskAnchor.revision;
      const shouldRefreshSnapshot = input.refreshSnapshotBeforeTransition === true;
      const refreshedInstructionDeltaSnapshot: T3HomerInstructionDeltaSnapshot = {
        ...instructionDeltaSnapshot,
        snapshotRevision: revision,
      };
      const authoritativeUserMessageId =
        latestAuthoritativeMessage?.id ?? existingTaskAnchor.authoritativeUserMessageId;

      const refreshedTaskAnchor: T3HomerTaskAnchor = {
        ...existingTaskAnchor,
        objective,
        sourceDocumentPaths,
        constraints,
        nonGoals,
        branchExpectation,
        revision,
        authoritativeUserMessageId,
        requiredExactCompletionPhrase,
        completionChecks,
        instructionDeltaSnapshot: refreshedInstructionDeltaSnapshot,
        updatedAt:
          instructionChangesDetected ||
          branchExpectationChanged ||
          authoritativeUserMessageId !== existingTaskAnchor.authoritativeUserMessageId
            ? input.createdAt
            : existingTaskAnchor.updatedAt,
      };

      if (
        !instructionChangesDetected &&
        !branchExpectationChanged &&
        !shouldRefreshSnapshot &&
        refreshedTaskAnchor.authoritativeUserMessageId ===
          existingTaskAnchor.authoritativeUserMessageId
      ) {
        return existingTaskAnchor;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: serverCommandId("task-anchor-refresh"),
        threadId: input.thread.id,
        homerTaskAnchor: refreshedTaskAnchor,
      });

      if (revision !== existingTaskAnchor.revision) {
        yield* appendAssignmentRevisionUpdatedActivity({
          threadId: input.thread.id,
          previousRevision: existingTaskAnchor.revision,
          nextRevision: revision,
          authoritativeUserMessageId,
          createdAt: input.createdAt,
          ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
        });
      }
      yield* appendInstructionSnapshotWrittenActivity({
        threadId: input.thread.id,
        snapshot: refreshedTaskAnchor.instructionDeltaSnapshot ?? refreshedInstructionDeltaSnapshot,
        createdAt: input.createdAt,
        ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      });

      return refreshedTaskAnchor;
    }

    const taskAnchor: T3HomerTaskAnchor = {
      objective,
      sourceDocumentPaths,
      constraints,
      nonGoals,
      branchExpectation,
      revision: nextRevision,
      authoritativeUserMessageId: latestAuthoritativeMessage?.id ?? null,
      requiredExactCompletionPhrase,
      completionChecks,
      instructionDeltaSnapshot: {
        ...instructionDeltaSnapshot,
        snapshotRevision: nextRevision,
      },
      updatedAt: input.createdAt,
    };

    yield* orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: serverCommandId("task-anchor-set"),
      threadId: input.thread.id,
      homerTaskAnchor: taskAnchor,
    });
    yield* appendAssignmentRevisionUpdatedActivity({
      threadId: input.thread.id,
      previousRevision: null,
      nextRevision: taskAnchor.revision,
      authoritativeUserMessageId: taskAnchor.authoritativeUserMessageId,
      createdAt: input.createdAt,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    });
    yield* appendInstructionSnapshotWrittenActivity({
      threadId: input.thread.id,
      snapshot: taskAnchor.instructionDeltaSnapshot ?? {
        instructionDeltas: [],
        snapshotRevision: taskAnchor.revision,
        createdAt: taskAnchor.updatedAt,
      },
      createdAt: input.createdAt,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    });

    return taskAnchor;
  });

  const buildHandoffPayload = (input: {
    readonly thread: OrchestrationThread;
    readonly taskAnchor: T3HomerTaskAnchor;
    readonly reason: string;
    readonly executionPolicy: T3HomerExecutionPolicy;
  }): T3HomerHandoffPayload => {
    const observed = collectObservedThreadState({
      thread: input.thread,
      taskAnchor: input.taskAnchor,
      reason: input.reason,
    });

    return {
      sourceThreadId: input.thread.id,
      goal: normalizeObjectiveForExecution(
        input.taskAnchor.objective,
        input.taskAnchor.sourceDocumentPaths,
      ),
      taskAnchor: input.taskAnchor,
      instructionDeltaSnapshot: input.taskAnchor.instructionDeltaSnapshot ?? {
        instructionDeltas: [],
        snapshotRevision: input.taskAnchor.revision,
        createdAt: input.taskAnchor.updatedAt,
      },
      verifiedDone: observed.verifiedDone,
      verifiedNotDone: observed.verifiedNotDone,
      nextAction:
        input.executionPolicy === "spawn_successor_thread"
          ? "Continue the same assignment in this successor thread. Treat this handoff as authoritative context."
          : "Continue from a fresh provider session on the same thread using the current repo state.",
      verificationStillRequired: observed.verificationStillRequired,
      relevantFilePaths: observed.relevantFilePaths,
      checkpointRef: observed.checkpointRef,
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

  const appendSuccessorPromotionActivity = Effect.fn("appendSuccessorPromotionActivity")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly reason: string;
      readonly createdAt: string;
      readonly turnId: TurnId | null;
      readonly escalation: HomerEscalationEvidence;
    }) {
      yield* appendActivity({
        threadId: input.threadId,
        kind: T3_HOMER_ACTIVITY_KINDS.escalated,
        summary: "T3 Homer promoted recovery to successor-thread fallback",
        tone: "error",
        turnId: input.turnId,
        createdAt: input.createdAt,
        payload: {
          reason: input.reason,
          executionPolicy: "spawn_successor_thread",
          triggerKind: input.escalation.triggerKind,
          attemptCount: input.escalation.attemptCount,
          assignmentRevision: input.escalation.assignmentRevision,
          lastKnownTurnId: input.escalation.lastKnownTurnId,
          checkpointRef: input.escalation.checkpointRef,
        },
      });
    },
  );

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
      refreshSnapshotBeforeTransition: true,
      turnId: input.turnId,
    });
    syncRevisionTracking(state, taskAnchor.revision);

    const nextInterventionCount = state.interventionCount + 1;

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
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: serverCommandId("restart-in-place-turn-start"),
      threadId: input.threadId,
      message: {
        messageId: MessageId.make(`t3homer:managed-resume:${crypto.randomUUID()}`),
        role: "user",
        text: buildManagedContinuationPrompt({
          thread,
          taskAnchor,
          executionPolicy: "restart_in_place",
          followUpText: `Automatic continuation after fresh-session handoff. Trigger reason: ${input.reason}`,
          followUpKind: "resume_managed_work",
        }),
        attachments: [],
      },
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: input.createdAt,
    });
    yield* appendContinuityPromptConsumedActivity({
      threadId: input.threadId,
      promptKind: "managed_continuation",
      executionPolicy: "restart_in_place",
      revision: taskAnchor.revision,
      snapshotRevision:
        taskAnchor.instructionDeltaSnapshot?.snapshotRevision ?? taskAnchor.revision,
      createdAt: input.createdAt,
      turnId: null,
    });

    state.warningCount = 0;
    state.errorCount = 0;
    state.interventionCount = nextInterventionCount;
    state.restartAttemptsForRevision += 1;
    state.interventionInProgress = false;
    state.pendingReason = null;
    state.supervisorState = "continue";
    state.lastIntervenedTurnId = input.turnId;
    state.lastKnownTurnId = input.turnId;
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
      refreshSnapshotBeforeTransition: true,
      turnId: input.turnId,
    });
    syncRevisionTracking(state, taskAnchor.revision);

    const nextInterventionCount = state.interventionCount + 1;

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
    yield* appendContinuityPromptConsumedActivity({
      threadId: successorThreadId,
      promptKind: "successor_handoff",
      executionPolicy: "spawn_successor_thread",
      revision: taskAnchor.revision,
      snapshotRevision:
        taskAnchor.instructionDeltaSnapshot?.snapshotRevision ?? taskAnchor.revision,
      createdAt: input.createdAt,
      turnId: null,
    });

    state.warningCount = 0;
    state.errorCount = 0;
    state.interventionCount = nextInterventionCount;
    state.interventionInProgress = false;
    state.pendingReason = null;
    state.pendingTurnRequestedAt = null;
    state.supervisorState = "continue";
    state.lastIntervenedTurnId = input.turnId;
    state.lastKnownTurnId = input.turnId;
  });

  const interveneOnThread = Effect.fn("interveneOnThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly reason: string;
    readonly createdAt: string;
    readonly interruptActiveTurn: boolean;
    readonly turnId: TurnId | null;
    readonly executionPolicy?: T3HomerExecutionPolicy;
    readonly allowPendingTimeoutPromotion?: boolean;
  }) {
    const resolved = yield* resolveThread(input.threadId);
    const thread = resolved.thread;
    if (!thread) {
      return;
    }

    const policyDecision = selectExecutionPolicy({
      thread,
      createdAt: input.createdAt,
      ...(input.executionPolicy ? { explicitPolicy: input.executionPolicy } : {}),
      ...(input.allowPendingTimeoutPromotion === true
        ? { allowPendingTimeoutPromotion: true }
        : {}),
    });

    if (policyDecision.executionPolicy === "spawn_successor_thread") {
      if (policyDecision.escalation !== null) {
        yield* appendSuccessorPromotionActivity({
          threadId: input.threadId,
          reason: input.reason,
          createdAt: input.createdAt,
          turnId: input.turnId,
          escalation: policyDecision.escalation,
        });
      }
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

      const followUpKind = classifyManagedFollowUpMessage(input.text);
      if (followUpKind === "user_takes_back_control") {
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
        summary: "T3 Homer handled a managed follow-up turn deterministically",
        createdAt: input.createdAt,
        tone: "info",
        payload: {
          followUpText: truncateValue(input.text, 120),
          followUpKind,
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
          turnId: null,
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
            followUpText: input.text,
            followUpKind,
          }),
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: input.createdAt,
      });
      yield* appendContinuityPromptConsumedActivity({
        threadId: input.threadId,
        promptKind: "managed_continuation",
        executionPolicy: managedState.executionPolicy,
        revision: taskAnchor.revision,
        snapshotRevision:
          taskAnchor.instructionDeltaSnapshot?.snapshotRevision ?? taskAnchor.revision,
        createdAt: input.createdAt,
        turnId: null,
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
      state.pendingTurnRequestedAt = event.payload.createdAt;
      state.supervisorState = "continue";
      state.lastIntervenedTurnId = null;
      state.suppressInterventionUntilNextTurnStart = false;
      yield* announceSupervisionIfNeeded({
        threadId: event.payload.threadId,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    if (
      event.type === "thread.turn-interrupt-requested" ||
      event.type === "thread.session-stop-requested"
    ) {
      state.warningCount = 0;
      state.errorCount = 0;
      state.pendingReason = null;
      state.pendingTurnRequestedAt = null;
      state.supervisorState = "continue";
      state.lastIntervenedTurnId = null;
      state.suppressInterventionUntilNextTurnStart = true;
      yield* releaseManagedAuthorityForExplicitStop({
        threadId: event.payload.threadId,
      });
      return;
    }

    if (event.type === "thread.turn-diff-completed") {
      state.lastKnownTurnId = event.payload.turnId;
      state.lastKnownCheckpointRef = event.payload.checkpointRef;
      state.pendingTurnRequestedAt = null;
      if (state.suppressInterventionUntilNextTurnStart) {
        return;
      }
      if (hasHandledTurn(state, event.payload.turnId) || state.interventionInProgress) {
        return;
      }
      if (event.payload.status === "ready") {
        const resolved = yield* resolveThread(event.payload.threadId);
        const thread = resolved.thread;
        if (thread !== null && thread.homerManagedWorkState !== null) {
          const revision = getAssignmentRevision(thread, state);
          syncRevisionTracking(state, revision);
          state.restartAttemptsForRevision = 0;
          state.lastSuccessfulCompletedTurnAtForRevision = event.payload.completedAt;
          state.runtimeFatalCountInManagedWindow = 0;
        }
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
    if (turnId !== null) {
      state.lastKnownTurnId = turnId;
    }

    if (state.suppressInterventionUntilNextTurnStart) {
      return;
    }

    if (
      event.type !== "turn.started" &&
      event.type !== "turn.completed" &&
      event.type !== "turn.aborted" &&
      !state.interventionInProgress &&
      !hasHandledTurn(state, turnId) &&
      hasPendingTurnTimedOut(state, event.createdAt)
    ) {
      yield* interveneOnThread({
        threadId: event.threadId,
        reason: "Turn start was requested but provider did not start within timeout.",
        createdAt: event.createdAt,
        interruptActiveTurn: false,
        turnId,
        allowPendingTimeoutPromotion: true,
      });
      return;
    }

    switch (event.type) {
      case "turn.started": {
        state.pendingTurnRequestedAt = null;
        return;
      }

      case "thread.token-usage.updated": {
        if (yield* isManagedWorkActive(event.threadId)) {
          return;
        }
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
        if (yield* isManagedWorkActive(event.threadId)) {
          return;
        }
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
        const resolved = yield* resolveThread(event.threadId);
        if (resolved.thread?.homerManagedWorkState !== null) {
          state.runtimeFatalCountInManagedWindow += 1;
        }
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
        state.pendingTurnRequestedAt = null;
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
          event.type !== "thread.turn-diff-completed" &&
          event.type !== "thread.turn-interrupt-requested" &&
          event.type !== "thread.session-stop-requested"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) => {
        switch (event.type) {
          case "turn.started":
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
