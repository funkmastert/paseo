export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
const OPEN_AGENT_TAB_LABEL_PREFIX = "paseo.open-agent-tab.";

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
