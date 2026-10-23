import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { followMigratedTo, getMigratedToFromLabels } from "@getpaseo/protocol/agent-labels";
import { resolveProviderLabel } from "@/utils/provider-definitions";

interface HeldAgentLabels {
  labels?: Record<string, unknown> | null;
}

/** An agent of one host the app holds, or undefined. */
export type HeldAgentLookup<T extends HeldAgentLabels = HeldAgentLabels> = (
  agentId: string,
) => T | null | undefined;

/**
 * What the app shows in place of an agent account failover may have retired
 * (docs/account-failover.md). `moved`: show `agentId`, the live end the app holds, instead of the
 * handle. `stranded`: the pointers loop or name an agent this host has not sent, so the handle stays
 * on screen and the note names `movedToAgentId`, its first hop.
 */
export type ShownAgentResolution =
  | { kind: "self" }
  | { kind: "moved"; agentId: string }
  | { kind: "stranded"; movedToAgentId: string };

export function resolveShownAgent(agentId: string, lookup: HeldAgentLookup): ShownAgentResolution {
  // A held agent with no labels still exists; only an agent the app lacks reads as null.
  const labelsOf = (id: string) => {
    const agent = lookup(id);
    return agent ? (agent.labels ?? {}) : null;
  };
  const movedToAgentId = getMigratedToFromLabels(labelsOf(agentId));
  if (!movedToAgentId) {
    return { kind: "self" };
  }
  const chain = followMigratedTo(agentId, labelsOf);
  if (chain.kind === "moved") {
    return { kind: "moved", agentId: chain.agentId };
  }
  return { kind: "stranded", movedToAgentId };
}

/** The agents the app holds for one host: the live list first, then fetched details. */
export function heldAgentLookup<T>(
  session: { agents: Map<string, T>; agentDetails: Map<string, T> } | undefined,
): (agentId: string) => T | undefined {
  return (agentId) => session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
}

export type AgentMoveNoteTarget =
  | { kind: "account"; label: string }
  | { kind: "agent"; agentId: string };

export type AgentMoveNoticeDecision =
  | { kind: "none" }
  | { kind: "wait" }
  | { kind: "show"; noticeId: number; target: AgentMoveNoteTarget };

/**
 * Whether to raise the "Moved to <account>" note now, and what it names. Each notice shows once.
 * It names the account by its display label, so it waits while the provider list loads; with no
 * list at all it falls back to the provider id. A successor the app does not hold is named by id.
 */
export function decideAgentMoveNotice(input: {
  notice: { id: number; agentId: string } | null;
  shownNoticeId: number | null;
  agent: { provider: string } | null;
  providerEntries: ProviderSnapshotEntry[] | undefined;
  providersLoading: boolean;
}): AgentMoveNoticeDecision {
  const { notice, agent } = input;
  if (!notice || notice.id === input.shownNoticeId) {
    return { kind: "none" };
  }
  if (!agent) {
    return {
      kind: "show",
      noticeId: notice.id,
      target: { kind: "agent", agentId: notice.agentId },
    };
  }
  if (!input.providerEntries && input.providersLoading) {
    return { kind: "wait" };
  }
  return {
    kind: "show",
    noticeId: notice.id,
    target: { kind: "account", label: resolveProviderLabel(agent.provider, input.providerEntries) },
  };
}
