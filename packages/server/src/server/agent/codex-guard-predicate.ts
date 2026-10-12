/**
 * The one predicate that decides whether a Codex CHILD guard applies: the create path, resume,
 * reload, and the mode lock (`setAgentMode`) all call this instead of each inventing its own
 * notion of "child." It replaces "child = callerAgentId", which the create guard checked while
 * the mode lock checked `paseo.parent-agent-id` instead — two different, driftable definitions of
 * the same thing (review findings #0, #3).
 *
 * True when the session family is `codex` and the agent is not human-made. "Human-made" mirrors
 * `isHumanAttributableCreate` (workspace-auto-pin.ts): no `callerAgentId` and no inherited
 * `paseo.parent-agent-id` label. A durable `paseo.codex-guarded` marker (stamped the first time
 * this predicate forces guarded mode) also counts on its own, so a child that later loses its
 * parent label — relabel, detach, archive — still can't leave guarded (review finding #0): the
 * marker is protected (`PROTECTED_LABEL_KEYS`), the label is not.
 */
import { CODEX_GUARDED_LABEL, getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { AgentProvider } from "./agent-sdk-types.js";

export function hasCodexGuardMarker(labels: Record<string, string> | null | undefined): boolean {
  return labels?.[CODEX_GUARDED_LABEL] === "1";
}

export interface RequiresCodexGuardInput {
  /** The CREATE's own caller, when one is being decided. Absent for resume/reload, which have
   * no caller of their own and decide purely from the stored record's labels. */
  callerAgentId?: string | null;
  labels?: Record<string, string> | null;
  /** The session family of the FINAL provider (`resolveProviderSessionFamily`), not the literal
   * provider id — a provider declared `extends: "codex"` must guard exactly like `codex` itself
   * (review finding #2). */
  providerFamily: AgentProvider;
}

export function requiresCodexGuard(input: RequiresCodexGuardInput): boolean {
  if (input.providerFamily !== "codex") {
    return false;
  }
  if (hasCodexGuardMarker(input.labels)) {
    return true;
  }
  return Boolean(input.callerAgentId) || getParentAgentIdFromLabels(input.labels) !== null;
}
