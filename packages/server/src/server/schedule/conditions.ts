/**
 * The gate on a conditional heartbeat: given what the daemon already knows about the target
 * agent and its children, does this tick have anything to do? Pure. No I/O and no clock reads;
 * the schedule service builds the agent views and passes the schedule's own timestamps in.
 *
 * A tick that fails the gate costs nothing: no run is recorded, no prompt is sent, the target
 * sees no turn. That is the point. Every wake into a leader re-bills its whole context, and a
 * tick that finds nothing looks like ordinary work, so nothing else would flag it.
 */
import type {
  ScheduleCondition,
  ScheduleConditionLeaf,
} from "@getpaseo/protocol/schedule/condition";
import type { DoneJanitorAgentView } from "../agent/done-janitor-detector.js";
import { parentOf } from "../agent/done-janitor-detector.js";

export type ConditionVerdict = { fire: true; reason: string } | { fire: false; reason: string };

export interface ConditionInput {
  /** The heartbeat's target as the daemon sees it. Null when it has no record at all. */
  target: DoneJanitorAgentView | null;
  /** Every agent view, the target's children among them. */
  views: readonly DoneJanitorAgentView[];
  /** When the heartbeat was created. */
  createdAtMs: number;
  /** When it last fired. Null if it never has. */
  lastRunAtMs: number | null;
}

function isRunning(view: DoneJanitorAgentView): boolean {
  return (
    view.live && (view.lifecycle === "running" || view.lifecycle === "initializing" || view.busy)
  );
}

/**
 * An agent mid-turn or blocked on a permission. Firing into it would be a failed run today
 * ("already has an active run") and a wasted steer otherwise. It also means the target is
 * already awake and reading its own state, so the wake has nothing to add.
 */
function isOccupied(view: DoneJanitorAgentView): boolean {
  return isRunning(view) || (view.live && view.pendingPermissionCount > 0);
}

function childrenOf(
  targetId: string,
  views: readonly DoneJanitorAgentView[],
): DoneJanitorAgentView[] {
  return views.filter((view) => !view.archived && parentOf(view) === targetId);
}

/**
 * The line a child's finish has to cross to count as news. The target's own last activity is
 * the latest point at which it could have read that child, so a finish it has already seen (it
 * was woken by the finish, or read the result mid-turn) does not wake it again. The heartbeat's
 * own timestamps cover a target with no activity yet.
 */
function newsHorizonMs(input: ConditionInput, target: DoneJanitorAgentView): number {
  return Math.max(input.createdAtMs, input.lastRunAtMs ?? 0, target.lastActivityAtMs ?? 0);
}

function evaluateLeaf(
  leaf: ScheduleConditionLeaf,
  input: ConditionInput,
  target: DoneJanitorAgentView,
): ConditionVerdict {
  switch (leaf.type) {
    case "always":
      return { fire: true, reason: "always" };
    case "hasActiveChildren": {
      const running = childrenOf(target.id, input.views).filter(isRunning);
      if (running.length > 0) {
        return { fire: true, reason: `${running.length} child agent(s) still running` };
      }
      if (target.runningProviderSubagentCount > 0) {
        return {
          fire: true,
          reason: `${target.runningProviderSubagentCount} provider subagent(s) still running`,
        };
      }
      return { fire: false, reason: "no child is running" };
    }
    case "childFinishedSince": {
      const horizon = newsHorizonMs(input, target);
      const finished = childrenOf(target.id, input.views).filter(
        (child) =>
          !isRunning(child) &&
          child.lifecycle !== "initializing" &&
          child.lastActivityAtMs !== null &&
          child.lastActivityAtMs > horizon,
      );
      if (finished.length > 0) {
        return { fire: true, reason: `${finished.length} child agent(s) finished since last seen` };
      }
      return { fire: false, reason: "no child has finished since the target last acted" };
    }
  }
}

export function evaluateScheduleCondition(
  condition: ScheduleCondition,
  input: ConditionInput,
): ConditionVerdict {
  const { target } = input;
  // Nothing to evaluate against. Fire, so the executor finds the target gone and completes the
  // schedule. Holding it back here would leave an orphan ticking forever.
  if (!target || target.archived) {
    return { fire: true, reason: "target not found" };
  }
  if (condition.type === "always") {
    return { fire: true, reason: "always" };
  }
  if (isOccupied(target)) {
    return { fire: false, reason: "target is busy" };
  }
  const leaves = condition.type === "any" ? condition.conditions : [condition];
  const verdicts = leaves.map((leaf) => evaluateLeaf(leaf, input, target));
  const met = verdicts.find((verdict) => verdict.fire);
  return met ?? { fire: false, reason: verdicts.map((verdict) => verdict.reason).join("; ") };
}
