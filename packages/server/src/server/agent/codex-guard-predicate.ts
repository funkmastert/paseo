/**
 * The one predicate that decides whether a Codex CHILD guard applies: the create path, resume,
 * reload, and the mode lock (`setAgentMode`) all call this instead of each inventing its own
 * notion of "child." It replaces "child = callerAgentId", which the create guard checked while
 * the mode lock checked `paseo.parent-agent-id` instead — two different, driftable definitions of
 * the same thing.
 *
 * True when the session family is `codex` and the agent is not human-made. A CREATE decides
 * "human-made" from its daemon-assigned `origin`: `origin !== "human"` guards, same as an absent
 * `origin` on a create that forgot to set one -- fail closed. Resume and reload have no origin of
 * their own (they reconstruct a stored record, not a fresh create) and omit the field entirely,
 * falling back to `isHumanAttributableCreate` (workspace-auto-pin.ts): no `callerAgentId` and no
 * inherited `paseo.parent-agent-id` label. A durable `paseo.codex-guarded` marker (stamped the
 * first time this predicate forces guarded mode) also counts on its own, so a child that later
 * loses its parent label — relabel, detach, archive — still can't leave guarded: the marker is
 * protected (`PROTECTED_LABEL_KEYS`), the label is not.
 */
import { CODEX_GUARDED_LABEL, type AgentCreateOrigin } from "@getpaseo/protocol/agent-labels";
import { isHumanAttributableCreate } from "../workspace-auto-pin.js";
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
   * provider id — a provider declared `extends: "codex"` must guard exactly like `codex` itself. */
  providerFamily: AgentProvider;
  /** The CREATE's daemon-assigned origin. Only ever present when a fresh create is being decided
   * -- resume/reload never pass it, since a persisted record has no origin of its own to
   * re-decide. When present and not `"human"`, this alone forces the guard, regardless of
   * `callerAgentId`/labels -- a Hub execution or remediation agent carries neither. */
  origin?: AgentCreateOrigin;
}

export function requiresCodexGuard(input: RequiresCodexGuardInput): boolean {
  if (input.providerFamily !== "codex") {
    return false;
  }
  if (hasCodexGuardMarker(input.labels)) {
    return true;
  }
  if (input.origin !== undefined && input.origin !== "human") {
    return true;
  }
  return !isHumanAttributableCreate({
    callerAgentId: input.callerAgentId,
    labels: input.labels ?? undefined,
  });
}
