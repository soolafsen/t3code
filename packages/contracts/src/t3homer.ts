import { Effect, Schema } from "effect";
import {
  CheckpointRef,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";

export const T3_HOMER_ACTIVITY_KINDS = {
  supervising: "t3homer.supervising",
  prepareHandoff: "t3homer.prepare-handover",
  handoffPrepared: "t3homer.handoff-prepared",
  statusCheckHandled: "t3homer.status-check.handled",
  checkpointResetRequested: "t3homer.checkpoint-reset.requested",
  checkpointResetCompleted: "t3homer.checkpoint-reset.completed",
  successorThreadSpawned: "t3homer.successor-thread.spawned",
  successorThreadCreated: "t3homer.successor-thread.created",
  sessionStarted: "t3homer.session.started",
  sessionEnded: "t3homer.session.ended",
  sessionInterrupted: "t3homer.session.interrupted",
  escalated: "t3homer.escalated",
} as const;

export type T3HomerActivityKind =
  (typeof T3_HOMER_ACTIVITY_KINDS)[keyof typeof T3_HOMER_ACTIVITY_KINDS];

export const T3HomerExecutionPolicy = Schema.Literals([
  "restart_in_place",
  "spawn_successor_thread",
]);
export type T3HomerExecutionPolicy = typeof T3HomerExecutionPolicy.Type;

export const T3HomerRecoveryMode = Schema.Literal("checkpoint_reset");
export type T3HomerRecoveryMode = typeof T3HomerRecoveryMode.Type;

export const T3HomerTransitionKind = Schema.Literal("spawn_successor_thread");
export type T3HomerTransitionKind = typeof T3HomerTransitionKind.Type;

export const T3HomerCheckpointResetReason = Schema.Literals([
  "checkpoint_missing",
  "checkpoint_error",
  "manual",
]);
export type T3HomerCheckpointResetReason = typeof T3HomerCheckpointResetReason.Type;

export const T3HomerTaskAnchor = Schema.Struct({
  objective: TrimmedNonEmptyString,
  sourceDocumentPaths: Schema.Array(TrimmedNonEmptyString),
  constraints: Schema.Array(TrimmedNonEmptyString),
  nonGoals: Schema.Array(TrimmedNonEmptyString),
  branchExpectation: Schema.NullOr(TrimmedNonEmptyString),
  authoritativeUserMessageId: Schema.NullOr(MessageId),
  requiredExactCompletionPhrase: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  completionChecks: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  updatedAt: IsoDateTime,
});
export type T3HomerTaskAnchor = typeof T3HomerTaskAnchor.Type;

export const T3HomerManagedWorkStatus = Schema.Literals(["active", "manual_attention"]);
export type T3HomerManagedWorkStatus = typeof T3HomerManagedWorkStatus.Type;

export const T3HomerManagedWorkState = Schema.Struct({
  status: T3HomerManagedWorkStatus,
  executionPolicy: T3HomerExecutionPolicy,
  activatedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type T3HomerManagedWorkState = typeof T3HomerManagedWorkState.Type;

export const T3HomerHandoffPayload = Schema.Struct({
  sourceThreadId: ThreadId,
  goal: Schema.String,
  taskAnchor: T3HomerTaskAnchor,
  verifiedDone: Schema.Array(TrimmedNonEmptyString),
  verifiedNotDone: Schema.Array(TrimmedNonEmptyString),
  nextAction: TrimmedNonEmptyString,
  verificationStillRequired: Schema.Array(TrimmedNonEmptyString),
  relevantFilePaths: Schema.Array(TrimmedNonEmptyString),
  checkpointRef: Schema.NullOr(CheckpointRef),
  executionPolicy: T3HomerExecutionPolicy,
});
export type T3HomerHandoffPayload = typeof T3HomerHandoffPayload.Type;

export const T3HomerCheckpointResetPayload = Schema.Struct({
  targetCheckpointTurnCount: NonNegativeInt,
  targetCheckpointRef: CheckpointRef,
  latestCheckpointTurnCount: NonNegativeInt,
  latestCheckpointStatus: Schema.Literals(["ready", "missing", "error"]),
  resetReason: T3HomerCheckpointResetReason,
  reason: TrimmedNonEmptyString,
  executionPolicy: T3HomerExecutionPolicy,
});
export type T3HomerCheckpointResetPayload = typeof T3HomerCheckpointResetPayload.Type;
