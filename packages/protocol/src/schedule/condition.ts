import { z } from "zod";

// A heartbeat's gate, evaluated by the daemon before it fires so a tick with nothing to do costs
// no agent turn. Absent means `always`: today's behavior, fire on every tick. Each leaf reads
// state the daemon already holds; nothing here makes a model call. The vocabulary is a closed
// set so a client and daemon agree on it; new leaves are added as new `type` values.
//
// COMPAT(scheduleConditions): added in v0.8.0, remove the feature gate after 2027-09-23. A daemon
// that predates it strips the field and the heartbeat fires on every tick, which is the cost the
// condition exists to avoid, so clients check `server_info.features.scheduleConditions` first.
export const ScheduleConditionLeafSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("always") }),
  z.object({ type: z.literal("hasActiveChildren") }),
  z.object({ type: z.literal("childFinishedSince") }),
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
] as const satisfies readonly ScheduleConditionName[];

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
