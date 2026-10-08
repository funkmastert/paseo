export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
const OPEN_AGENT_TAB_LABEL_PREFIX = "paseo.open-agent-tab.";

/**
 * An explicit knowledge-base project assignment for an agent create, the strongest of the three
 * signals KTD-7 checks in order (docs/knowledge-base.md). Its value is the project's slug.
 */
export const KB_PROJECT_LABEL = "paseo.kb-project";

/** Whether a spawned agent got the JEV agent tools (docs/jev.md, "Features 4-6"). */
export const JEV_TOOLS_LABEL = "paseo.jev-tools";
/** "on": the tools are exposed. "control": the D8 hold-out arm, withheld on purpose. */
export const JEV_TOOLS_LABEL_VALUES = ["on", "control"] as const;

/** The `callId` of the JEV decision behind a create, so `jev.decisions.list` can attach it. */
export const JEV_CALL_LABEL = "paseo.jev-call";

/**
 * The spawn hint's durable record, written beside `paseo.jev-call` by the role router:
 * `v1;base=<class>/<model>;would=<class>/<model>;move=<down|up|none>;applied=<0|1>`. The savings
 * ledger reads it when the agent is created (docs/jev.md, "Savings").
 */
export const JEV_SPAWN_LABEL = "paseo.jev-spawn";

/** How `paseo.task-class` was set: "declared" | "jev" | "classified" | "default". */
export const TASK_CLASS_SOURCE_LABEL = "paseo.task-class-source";

export function getOpenAgentTabLabel(clientId: string): string {
  return `${OPEN_AGENT_TAB_LABEL_PREFIX}${clientId}`;
}

export function isOpenAgentTabLabel(label: string): boolean {
  return label.startsWith(OPEN_AGENT_TAB_LABEL_PREFIX);
}

export interface AgentLabelSource {
  labels?: Record<string, unknown> | null;
}

export function getParentAgentIdFromLabels(labels: Record<string, unknown> | null | undefined) {
  const parentAgentId = labels?.[PARENT_AGENT_ID_LABEL];
  return typeof parentAgentId === "string" && parentAgentId.trim().length > 0
    ? parentAgentId.trim()
    : null;
}

export function isDelegatedAgent(agent: AgentLabelSource): boolean {
  return getParentAgentIdFromLabels(agent.labels) !== null;
}

export function hasOpenAgentTab(labels: Record<string, unknown> | null | undefined): boolean {
  return Object.entries(labels ?? {}).some(
    ([label, value]) => isOpenAgentTabLabel(label) && value === "true",
  );
}

/**
 * Set by account failover on a handle it retired when the conversation moved to a new agent id
 * (docs/account-failover.md). A blank value reads as unset: a revived handle is the live end again.
 */
export const ACCOUNT_FAILOVER_MIGRATED_TO_LABEL = "paseo.account-failover.migrated-to";

export function getMigratedToFromLabels(
  labels: Record<string, unknown> | null | undefined,
): string | null {
  const migratedTo = labels?.[ACCOUNT_FAILOVER_MIGRATED_TO_LABEL];
  return typeof migratedTo === "string" && migratedTo.trim().length > 0 ? migratedTo.trim() : null;
}

export type MigrationChainResult =
  /** Never moved, or its pointer names an agent that no longer exists. */
  | { kind: "self"; agentId: string }
  /** `agentId` is the live end; `chain` runs from the handle asked about to it. */
  | { kind: "moved"; agentId: string; chain: string[] }
  /** The pointers loop, so there is no live end to deliver to. `chain` ends on the repeat. */
  | { kind: "loop"; chain: string[] };

/**
 * Where a conversation that account failover moved lives now: follow `migrated-to` from `agentId`
 * until an agent without one. `labelsOf` returns null for an agent that does not exist, which
 * ends the walk at the last one that does.
 */
export function followMigratedTo(
  agentId: string,
  labelsOf: (agentId: string) => Record<string, unknown> | null | undefined,
): MigrationChainResult {
  const chain = [agentId];
  let current = agentId;
  for (;;) {
    const next = getMigratedToFromLabels(labelsOf(current));
    if (!next || labelsOf(next) == null) {
      return chain.length === 1
        ? { kind: "self", agentId: current }
        : { kind: "moved", agentId: current, chain };
    }
    if (chain.includes(next)) {
      return { kind: "loop", chain: [...chain, next] };
    }
    chain.push(next);
    current = next;
  }
}
