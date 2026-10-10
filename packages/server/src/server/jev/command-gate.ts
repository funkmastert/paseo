import {
  checkCatastrophe,
  formatCatastropheDenial,
  resolveCurrentBranchWithGit,
  type CurrentBranchResolver,
} from "../agent/catastrophe-gate.js";
import type { CommandGate } from "./contract.js";

const GATE_ERROR_REASON =
  "the catastrophe gate could not check this command; run it with Bash, which is gated too";

export interface CatastropheCommandGateOptions {
  /** `agents.catastropheGate.enabled`, read per call like the Bash hook reads it. */
  isEnabled: () => boolean;
  check?: typeof checkCatastrophe;
  resolveCurrentBranch?: CurrentBranchResolver;
}

/**
 * `ask_jev`'s `command` asks the catastrophe gate what a Bash call would be told
 * (docs/catastrophe-gate.md). Unlike the Bash hook it fails closed: refusing here costs the agent a
 * retry in Bash, which is itself gated, while allowing an unchecked command would let a JEV tool
 * run what Bash would not.
 */
export function createCatastropheCommandGate(options: CatastropheCommandGateOptions): CommandGate {
  const check = options.check ?? checkCatastrophe;
  const resolveCurrentBranch = options.resolveCurrentBranch ?? resolveCurrentBranchWithGit;
  return async ({ command, cwd }) => {
    try {
      if (!options.isEnabled()) return { allowed: true, reason: null };
      const decision = await check(command, cwd, resolveCurrentBranch);
      if (!decision.block) return { allowed: true, reason: null };
      return { allowed: false, reason: formatCatastropheDenial(decision, command) };
    } catch {
      return { allowed: false, reason: GATE_ERROR_REASON };
    }
  };
}
