import type { AgentNeedsInput } from "@getpaseo/protocol/agent-types";
import { isLimitShapedError } from "./account-failover-detector.js";
import type { AgentPermissionRequestKind } from "./agent-sdk-types.js";

/**
 * Pure derivation of the needs-input and resumability axes added to the agent snapshot (OR-D1,
 * docs/agent-lifecycle.md#needs-input). Every input here is already in hand at projection time —
 * no new monitor, no I/O. See agent-projections.ts for the call sites.
 */

export interface NeedsInputInput {
  /** Kind of every currently pending permission request on this agent. */
  pendingPermissionKinds: readonly AgentPermissionRequestKind[];
  status: "initializing" | "idle" | "running" | "error" | "closed";
  lastError: string | undefined;
  /** The spend governor's `pause` stage has fired and the agent has not resumed since. */
  spendPaused: boolean;
}

/** Undefined when nothing needs input — an agent simply working carries nothing on the wire. */
export function computeNeedsInput(input: NeedsInputInput): AgentNeedsInput | undefined {
  let count = 0;
  const reasons = new Set<string>();

  for (const kind of input.pendingPermissionKinds) {
    count += 1;
    reasons.add(kind === "question" ? "question" : "permission");
  }

  if (input.status === "error" && isLimitShapedError(input.lastError)) {
    count += 1;
    reasons.add("usage_limit");
  }

  if (input.spendPaused) {
    count += 1;
    reasons.add("spend_paused");
  }

  if (count === 0) {
    return undefined;
  }
  return { count, reasons: [...reasons] };
}

export interface ResumabilityInput {
  /** A provider runtime is resident for this agent — any status other than `closed`. */
  isLive: boolean;
  hasPersistenceHandle: boolean;
  /**
   * Whether the persistence handle's provider is still registered and enabled, when that is
   * cheaply known from a registered-provider list already in hand (buildStoredAgentPayload's
   * `validProviders`). Omitted by the live in-memory path, which has no such list on hand and
   * is not worth fetching one for.
   */
  providerAvailable?: boolean;
}

/** See AgentResumability's doc comment in agent-types.ts for what each returned value means. */
export function computeResumability(input: ResumabilityInput): string {
  if (input.isLive) {
    return "live";
  }
  if (!input.hasPersistenceHandle) {
    return "unreachable";
  }
  if (input.providerAvailable === false) {
    return "unreachable";
  }
  if (input.providerAvailable === undefined) {
    return "unknown";
  }
  return "resumable";
}
