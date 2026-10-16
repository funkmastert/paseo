import {
  conditionFromNames,
  conditionNames,
  type ScheduleCondition,
} from "@getpaseo/protocol/schedule/condition";

// What the heartbeat editor offers. The wire condition is any-of a closed set of names; the
// editor exposes the combinations that make sense for a leader, one choice at a time.
export type HeartbeatWake = "always" | "childrenRunning" | "childFinished" | "either";

export const HEARTBEAT_WAKE_LABELS: Record<HeartbeatWake, string> = {
  always: "Every tick",
  childrenRunning: "While an agent I started is running",
  childFinished: "When an agent I started finishes",
  either: "While one is running or when one finishes",
};

export const HEARTBEAT_WAKE_ORDER: readonly HeartbeatWake[] = [
  "always",
  "childrenRunning",
  "childFinished",
  "either",
];

export function wakeFromCondition(condition: ScheduleCondition | undefined): HeartbeatWake {
  if (!condition) {
    return "always";
  }
  const names = new Set(conditionNames(condition));
  if (names.has("always")) {
    return "always";
  }
  const running = names.has("hasActiveChildren");
  const finished = names.has("childFinishedSince");
  if (running && finished) {
    return "either";
  }
  if (running) {
    return "childrenRunning";
  }
  return finished ? "childFinished" : "always";
}

/** Null clears the condition on the daemon, which is what "Every tick" means. */
export function conditionFromWake(wake: HeartbeatWake): ScheduleCondition | null {
  switch (wake) {
    case "always":
      return null;
    case "childrenRunning":
      return conditionFromNames(["hasActiveChildren"]);
    case "childFinished":
      return conditionFromNames(["childFinishedSince"]);
    case "either":
      return conditionFromNames(["hasActiveChildren", "childFinishedSince"]);
  }
}
