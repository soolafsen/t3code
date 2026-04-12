import type { IsoDateTime, ServerSettingsError, ThreadId } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect, Scope } from "effect";
import type { OrchestrationDispatchError } from "../Errors.ts";

export type T3HomerForceHandoffResult = "triggered" | "disabled" | "thread_not_found";

export interface T3HomerSupervisorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
  readonly forceHandoff: (input: {
    readonly threadId: ThreadId;
    readonly createdAt: IsoDateTime;
    readonly reason?: string;
  }) => Effect.Effect<T3HomerForceHandoffResult, ServerSettingsError | OrchestrationDispatchError>;
}

export class T3HomerSupervisor extends Context.Service<T3HomerSupervisor, T3HomerSupervisorShape>()(
  "t3/orchestration/Services/T3HomerSupervisor",
) {}
