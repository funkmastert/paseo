import { z } from "zod";

// A heartbeat's gate, evaluated by the daemon before it fires so a tick with nothing to do costs
// no agent turn. Absent means `always`: today's behavior, fire on every tick. Each leaf reads
// state the daemon already holds; nothing here makes a model call. The vocabulary is a closed
// set so a client and daemon agree on it; new leaves are added as new `type` values.
//
// COMPAT(scheduleConditions): added in v0.8.0, remove the feature gate after 2027-09-23. A daemon
// that predates it strips the field and the heartbeat fires on every tick, which is the cost the
// condition exists to avoid, so clients check `server_info.features.scheduleConditions` first.
// COMPAT(scheduleConditionItemLeaves): added in v0.9.0, remove the client-capability gate after
// 2027-10-01 once the supported client floor advertises it. These four leaves read the work
// queue (OR-A1) and context usage, added after the first three shipped, so an old client's
// strict union would reject a schedule carrying one. The daemon projects them down to `always`
// for a client that does not advertise `CLIENT_CAPS.scheduleConditionItemLeaves`
// (session/schedule/schedule-session.ts) rather than ever sending one it cannot parse.
export const ScheduleConditionLeafSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("always") }),
  z.object({ type: z.literal("hasActiveChildren") }),
  z.object({ type: z.literal("childFinishedSince") }),
  // The target (an agent) owns at least one open work item (pending, in-progress or blocked).
  z.object({ type: z.literal("ownsOpenItems") }),
  // The target owns an open item with no transition for longer than `thresholdMinutes`.
  z.object({ type: z.literal("itemOverdue"), thresholdMinutes: z.number().positive().optional() }),
  // The target is idle (already implied by the gate above) and a `pending` item is assigned to it.
  z.object({ type: z.literal("idleWithClaimableGate") }),
  // The target's cached context usage is at or above `percent` of its window. Reads the daemon's
  // existing context-usage cache (docs/context-usage.md); never triggers a new capture.
  z.object({ type: z.literal("contextAbove"), percent: z.number().positive().optional() }),
]);
export type ScheduleConditionLeaf = z.infer<typeof ScheduleConditionLeafSchema>;

export const ScheduleConditionSchema = z.discriminatedUnion("type", [
  ...ScheduleConditionLeafSchema.options,
  z.object({
    type: z.literal("any"),
    conditions: z.array(ScheduleConditionLeafSchema).min(1),
  }),
]);
export type ScheduleCondition = z.infer<typeof ScheduleConditionSchema>;

export type ScheduleConditionName = ScheduleConditionLeaf["type"];
export const SCHEDULE_CONDITION_NAMES = [
  "always",
  "hasActiveChildren",
  "childFinishedSince",
  "ownsOpenItems",
  "itemOverdue",
  "idleWithClaimableGate",
  "contextAbove",
] as const satisfies readonly ScheduleConditionName[];

/** The four item/context leaves gated on `CLIENT_CAPS.scheduleConditionItemLeaves`. */
export const SCHEDULE_CONDITION_ITEM_LEAF_NAMES = [
  "ownsOpenItems",
  "itemOverdue",
  "idleWithClaimableGate",
  "contextAbove",
] as const satisfies readonly ScheduleConditionName[];

function isItemLeafName(name: ScheduleConditionName): boolean {
  return (SCHEDULE_CONDITION_ITEM_LEAF_NAMES as readonly string[]).includes(name);
}

/**
 * What a client that does not advertise `scheduleConditionItemLeaves` may be sent: the condition
 * unchanged when it carries none of the four new leaves, each new leaf dropped from an `any` list
 * (falling back to `always` if that empties it), or `always` outright for a bare new leaf. Never
 * send a leaf type the client's schema does not know.
 */
export function projectScheduleConditionForClient(
  condition: ScheduleCondition,
  supportsItemLeaves: boolean,
): ScheduleCondition {
  if (supportsItemLeaves) return condition;
  if (condition.type === "any") {
    const kept = condition.conditions.filter((leaf) => !isItemLeafName(leaf.type));
    if (kept.length === condition.conditions.length) return condition;
    if (kept.length === 0) return { type: "always" };
    if (kept.length === 1) return kept[0];
    return { type: "any", conditions: kept };
  }
  return isItemLeafName(condition.type) ? { type: "always" } : condition;
}

/** `--when a,b` and the MCP `when` list both mean "any of these". One name is that leaf. */
export function conditionFromNames(names: readonly ScheduleConditionName[]): ScheduleCondition {
  const leaves = names.map((type) => ({ type }));
  if (leaves.length === 0) {
    throw new Error("A condition needs at least one name");
  }
  if (leaves.length === 1) {
    return leaves[0];
  }
  return { type: "any", conditions: leaves };
}

export function parseConditionNames(value: string): ScheduleConditionName[] {
  const names = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (names.length === 0) {
    throw new Error(`Condition is empty. Use one of: ${SCHEDULE_CONDITION_NAMES.join(", ")}`);
  }
  return names.map((name) => {
    const parsed = ScheduleConditionLeafSchema.safeParse({ type: name });
    if (!parsed.success) {
      throw new Error(
        `Unknown condition "${name}". Use one of: ${SCHEDULE_CONDITION_NAMES.join(", ")}`,
      );
    }
    return parsed.data.type;
  });
}

export function conditionNames(condition: ScheduleCondition): ScheduleConditionName[] {
  return condition.type === "any"
    ? condition.conditions.map((leaf) => leaf.type)
    : [condition.type];
}
