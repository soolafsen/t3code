import type {
  IsoDateTime,
  T3HomerRecoveryMode,
  ServerSettingsError,
  T3HomerExecutionPolicy,
  ThreadId,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect, Scope } from "effect";
import type { OrchestrationDispatchError } from "../Errors.ts";

export type T3HomerForceHandoffResult =
  | "triggered"
  | "disabled"
  | "thread_not_found"
  | "checkpoint_reset_unavailable";

export type T3HomerHandleUserTurnResult = "pass_through" | "handled";

export interface T3HomerSupervisorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
  readonly handleUserTurn: (input: {
    readonly threadId: ThreadId;
    readonly text: string;
    readonly createdAt: IsoDateTime;
  }) => Effect.Effect<
    T3HomerHandleUserTurnResult,
    ServerSettingsError | OrchestrationDispatchError
  >;
  readonly forceHandoff: (input: {
    readonly threadId: ThreadId;
    readonly createdAt: IsoDateTime;
    readonly reason?: string;
    readonly executionPolicy?: T3HomerExecutionPolicy;
    readonly recoveryMode?: T3HomerRecoveryMode;
  }) => Effect.Effect<T3HomerForceHandoffResult, ServerSettingsError | OrchestrationDispatchError>;
}

export class T3HomerSupervisor extends Context.Service<T3HomerSupervisor, T3HomerSupervisorShape>()(
  "t3/orchestration/Services/T3HomerSupervisor",
) {}
