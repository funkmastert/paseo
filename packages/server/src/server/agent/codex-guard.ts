import {
  checkCatastrophe,
  formatCatastropheDenial,
  resolveCurrentBranchWithGit,
  type CurrentBranchResolver,
} from "./catastrophe-gate.js";
import type { DeviceLaunchGate } from "./device-lease-manager.js";

export interface CodexGuardDecision {
  decision: "accept" | "decline";
  reason?: string;
}

export interface CodexGuardLogger {
  warn: (obj: object, msg?: string) => void;
}

export interface CodexGuardCommandInput {
  command: string;
  cwd: string;
  agentId: string | undefined;
  deviceLaunchGate: DeviceLaunchGate | undefined;
  isCatastropheGateEnabled?: () => boolean;
  resolveCurrentBranch?: CurrentBranchResolver;
  logger?: CodexGuardLogger;
}

/**
 * The one guard decision for a guarded Codex child's command-approval request
 * (docs/catastrophe-gate.md, KTD-5): catastrophe gate first, then the device gate.
 *
 * Declines on any thrown error -- the opposite of Claude's hook, which fails open. A guarded
 * Codex child has no other layer: nothing runs until this function says yes.
 */
export async function decideCodexGuardedCommand(
  input: CodexGuardCommandInput,
): Promise<CodexGuardDecision> {
  try {
    const catastropheEnabled = input.isCatastropheGateEnabled
      ? input.isCatastropheGateEnabled()
      : true;
    if (catastropheEnabled) {
      const decision = await checkCatastrophe(
        input.command,
        input.cwd,
        input.resolveCurrentBranch ?? resolveCurrentBranchWithGit,
      );
      if (decision.block) {
        input.logger?.warn(
          {
            rule: decision.rule,
            agentId: input.agentId,
            provider: "codex",
            cwd: input.cwd,
            command: input.command.slice(0, 500),
          },
          "Catastrophe gate blocked a command",
        );
        return { decision: "decline", reason: formatCatastropheDenial(decision, input.command) };
      }
    }

    if (input.deviceLaunchGate && input.agentId) {
      const deviceDecision = await input.deviceLaunchGate.gateLaunch({
        agentId: input.agentId,
        command: input.command,
      });
      if (deviceDecision.decision === "deny") {
        return { decision: "decline", reason: deviceDecision.message };
      }
    }

    return { decision: "accept" };
  } catch (error) {
    input.logger?.warn({ err: error, agentId: input.agentId }, "Codex guard failed; declining");
    return { decision: "decline", reason: "Paseo guard failed; declining to be safe." };
  }
}
