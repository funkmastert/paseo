import type { Command } from "commander";
import type {
  RestartRecoveryEntry,
  RestartRecoveryPlan,
} from "@getpaseo/protocol/restart-recovery/rpc-schemas";
import { connectToDaemon } from "../utils/client.js";
import type { CommandError, CommandOptions, OutputSchema, SingleResult } from "../output/index.js";

export interface RecoverOptions extends CommandOptions {
  plan?: boolean;
  apply?: boolean;
  dismiss?: boolean;
  full?: boolean;
}

type RecoverAction = "plan" | "apply" | "dismiss";

export interface RecoverResult {
  action: RecoverAction;
  plan: RestartRecoveryPlan;
}

export function addRecoverOptions(command: Command): Command {
  return command
    .description(
      "Show or resume the agents the last daemon stop cut off mid-turn (restart recovery)",
    )
    .argument("[agentIds...]", "Limit --apply or --dismiss to these agents")
    .option("--plan", "Show the recovery plan (default)")
    .option("--apply", "Resume the agents in the plan, leaders first")
    .option("--dismiss", "Leave these agents closed and stop offering them")
    .option("--full", "Show every readiness check, not just the ones that are not green");
}

function resolveAction(options: RecoverOptions): RecoverAction {
  const chosen = (["plan", "apply", "dismiss"] as const).filter((action) => options[action]);
  if (chosen.length > 1) {
    const error: CommandError = {
      code: "INVALID_OPTIONS",
      message: "Choose one of --plan, --apply or --dismiss",
    };
    throw error;
  }
  return chosen[0] ?? "plan";
}

function shortId(agentId: string): string {
  return agentId.slice(0, 8);
}

function describeEntry(entry: RestartRecoveryEntry, full: boolean): string[] {
  const indent = "  ".repeat(entry.depth);
  const title = entry.title ? ` ${entry.title}` : "";
  const lines = [
    `${indent}${shortId(entry.agentId)}${title}  ${entry.state}  ${entry.readiness}  ` +
      `(${entry.provider}, turn started ${entry.runStartedAt})`,
  ];
  if (entry.detail) lines.push(`${indent}    ${entry.detail}`);
  for (const check of entry.checks) {
    if (!full && check.status === "green") continue;
    lines.push(`${indent}    ${check.status} ${check.id}: ${check.detail}`);
  }
  return lines;
}

function nextStep(result: RecoverResult): string {
  const open = result.plan.entries.filter(
    (entry) => entry.state === "pending" || entry.state === "failed",
  );
  if (open.length === 0) return "Nothing left to recover.";
  return (
    `${open.length} agent(s) still waiting. Next: paseo recover --apply [agentIds...] to ` +
    "resume them, or paseo recover --dismiss [agentIds...] to leave them closed."
  );
}

function renderRecover(result: RecoverResult, full: boolean): string {
  const { plan, action } = result;
  if (plan.entries.length === 0) {
    return "No agent was mid-turn when the last daemon stopped. Nothing to recover.";
  }
  const counts = new Map<string, number>();
  for (const entry of plan.entries) {
    counts.set(entry.state, (counts.get(entry.state) ?? 0) + 1);
  }
  const summary = Array.from(counts, ([state, count]) => `${count} ${state}`).join(", ");
  const headings: Record<RecoverAction, string> = {
    apply: `Restart recovery applied: ${summary}.`,
    dismiss: `Restart recovery dismissed: ${summary}.`,
    plan: `${plan.entries.length} agent(s) were mid-turn when the daemon stopped: ${summary}.`,
  };
  const heading = headings[action];
  return [
    heading,
    `Mode ${plan.mode}; daemon started ${plan.capturedAt}; previous shutdown ${plan.previousShutdown}.`,
    "",
    ...plan.entries.flatMap((entry) => describeEntry(entry, full)),
    "",
    nextStep(result),
  ].join("\n");
}

function recoverSchema(full: boolean): OutputSchema<RecoverResult> {
  return {
    idField: (result) => result.plan.entries.map((entry) => entry.agentId).join("\n"),
    columns: [],
    renderHuman: (result) => (result.type === "single" ? renderRecover(result.data, full) : ""),
    serialize: (result) => result,
  };
}

export async function runRecoverCommand(
  agentIds: string[],
  options: RecoverOptions,
  _command: Command,
): Promise<SingleResult<RecoverResult>> {
  const action = resolveAction(options);
  const selection = agentIds.length > 0 ? { agentIds } : {};
  if (action === "plan" && agentIds.length > 0) {
    const error: CommandError = {
      code: "INVALID_OPTIONS",
      message: "Agent ids apply to --apply and --dismiss; --plan always shows the whole plan",
    };
    throw error;
  }
  const client = await connectToDaemon({ host: options.host });
  try {
    if (!client.getLastServerInfoMessage()?.features?.restartRecovery) {
      const error: CommandError = {
        code: "UNSUPPORTED",
        message: "This daemon does not support restart recovery. Update the daemon.",
      };
      throw error;
    }
    let plan: RestartRecoveryPlan;
    if (action === "apply") {
      plan = await client.applyRestartRecovery(selection);
    } else if (action === "dismiss") {
      plan = await client.dismissRestartRecovery(selection);
    } else {
      plan = await client.getRestartRecoveryPlan();
    }
    return {
      type: "single",
      data: { action, plan },
      schema: recoverSchema(options.full === true),
    };
  } finally {
    await client.close();
  }
}
