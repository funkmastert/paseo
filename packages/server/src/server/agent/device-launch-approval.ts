/**
 * The device cap's second rung (docs/device-leases.md).
 *
 * Claude and OpenCode can be refused at the tool call itself. Codex and the ACP providers
 * cannot — the daemon's only pre-execution say is the approval request the agent sends, and
 * that only arrives in the modes where the agent asks at all. This is what to do with it when
 * it does arrive.
 *
 * Neither protocol carries a sentence back to the model with the rejection: Codex's exec
 * approval resolves to a bare decision, and ACP's resolves to an option id. A refusal that only
 * says "no" turns into a retry loop or a workaround, so the reason is delivered separately,
 * through the same steer path the resource monitor uses. Refuse first, then explain — the
 * agent's turn is parked on the approval until the rejection lands.
 */

import type { DeviceLaunchGate } from "./device-lease-manager.js";

interface DeviceLaunchApprovalLogger {
  warn: (obj: object, msg?: string) => void;
}

export interface EvaluateDeviceLaunchApprovalInput {
  gate: DeviceLaunchGate | undefined;
  agentId: string | undefined;
  /** The command the agent is asking to run. Nullable because both protocols allow it to be. */
  command: string | null | undefined;
  logger: DeviceLaunchApprovalLogger;
}

/**
 * The refusal message when the cap says no, `undefined` to let the approval take its normal
 * course. Fails open on every uncertainty — no gate, no agent id, no command, a cap that
 * throws — because a device cap that breaks tool calls is worse than one that misses a device
 * the process scan catches a sweep later.
 */
export async function evaluateDeviceLaunchApproval(
  input: EvaluateDeviceLaunchApprovalInput,
): Promise<string | undefined> {
  const { gate, agentId, command } = input;
  if (!gate || !agentId || typeof command !== "string" || command.trim() === "") {
    return undefined;
  }
  try {
    const decision = await gate.gateLaunch({ agentId, command });
    return decision.decision === "deny" ? decision.message : undefined;
  } catch (error) {
    input.logger.warn({ err: error, agentId }, "Device launch gate failed; allowing the command");
    return undefined;
  }
}

/**
 * Puts the refusal's reason where the model will read it. Fire and forget: the rejection has
 * already been sent, and a steer that fails must not turn into a failed tool call.
 */
export function explainDeviceLaunchRefusal(input: {
  gate: DeviceLaunchGate | undefined;
  agentId: string | undefined;
  message: string;
  logger: DeviceLaunchApprovalLogger;
}): void {
  const explain = input.gate?.explainRefusalToAgent;
  if (!explain || !input.gate || !input.agentId) return;
  void explain
    .call(input.gate, { agentId: input.agentId, message: input.message })
    .catch((error: unknown) => {
      input.logger.warn(
        { err: error, agentId: input.agentId },
        "Failed to tell the agent why its device launch was refused",
      );
    });
}
