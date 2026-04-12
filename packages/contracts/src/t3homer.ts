export const T3_HOMER_ACTIVITY_KINDS = {
  supervising: "t3homer.supervising",
  prepareHandoff: "t3homer.prepare-handover",
  handoffPrepared: "t3homer.handoff-prepared",
  sessionStarted: "t3homer.session.started",
  sessionEnded: "t3homer.session.ended",
  sessionInterrupted: "t3homer.session.interrupted",
  escalated: "t3homer.escalated",
} as const;

export type T3HomerActivityKind =
  (typeof T3_HOMER_ACTIVITY_KINDS)[keyof typeof T3_HOMER_ACTIVITY_KINDS];
