export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
const OPEN_AGENT_TAB_LABEL_PREFIX = "paseo.open-agent-tab.";

/**
 * Who asked the daemon to create this agent, assigned explicitly by the entry point instead of
 * inferred from `callerAgentId`/labels after the fact (those drift per create path -- the Codex
 * child guard's round 3 fix). "human": an app/desktop/CLI client session with no `callerAgentId`.
 * "agent": a client session with `callerAgentId`, or the Paseo MCP endpoint (only agents use it).
 * "daemon": a Hub execution, a remediation agent, or any other daemon-owned create. A create that
 * never sets this is treated as agent-made -- new or forgotten paths are guarded by default, and
 * only the explicit human path opts out.
 */
export const AGENT_CREATE_ORIGINS = ["human", "agent", "daemon"] as const;
export type AgentCreateOrigin = (typeof AGENT_CREATE_ORIGINS)[number];

/**
 * Stamped by the daemon the first time a Codex child is forced into guarded mode (create,
 * resume, or reload). Protected (`PROTECTED_LABEL_KEYS`, agent-manager.ts) so `update_agent`
 * can't clear it: `paseo.parent-agent-id` is mutable and a child can lose it (relabel, detach,
 * archive), but this marker survives, so the mode lock has something durable to check.
 */
export const CODEX_GUARDED_LABEL = "paseo.codex-guarded";

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

/**
 * A remediation agent (`remediation/ladder.ts`) or a schedule/heartbeat run (`schedule/service.ts`).
 * The same two label pairs `away-reply/detect.ts`'s `leaderSkipReason` checks, shared here so the
 * two places that need "is this root agent actually daemon automation, not a Tyler-started
 * session" agree on what counts.
 */
export const REMEDIATION_LABELS = ["paseo.remediation", "paseo.remediation-key"] as const;
export const SCHEDULE_LABELS = ["paseo.schedule-id", "paseo.schedule-run"] as const;

/**
 * A remediation agent or a schedule/heartbeat run carries no `paseo.parent-agent-id` on purpose
 * (docs/remediation.md, docs/jev.md "role resolution") — it is a root agent by `isDelegatedAgent`,
 * but it is daemon-made, not a session Tyler started. A caller deciding whether a root agent's
 * finish is a question Tyler himself is being asked needs this distinction too.
 */
export function isDaemonAutomationAgent(agent: AgentLabelSource): boolean {
  const labels = agent.labels ?? {};
  return (
    REMEDIATION_LABELS.some((label) => label in labels) ||
    SCHEDULE_LABELS.some((label) => label in labels)
  );
}

/**
 * Completion state (docs/completion-state.md): an agent's own claim that it is ready to merge or
 * fully done, written by `set_completion_state`. Absent means no claim. `COMPLETION_NOTE_LABEL`
 * is an optional human summary of at most `COMPLETION_NOTE_MAX_LENGTH` characters;
 * `COMPLETION_AT_LABEL` is the ISO timestamp the state was set at. All three clear together the
 * moment the agent receives new, non-system-injected work (agent-manager.ts).
 */
export const COMPLETION_LABEL = "paseo.completion";
export const COMPLETION_NOTE_LABEL = "paseo.completion-note";
export const COMPLETION_AT_LABEL = "paseo.completion-at";
export const COMPLETION_NOTE_MAX_LENGTH = 200;

export const COMPLETION_STATES = ["ready-to-merge", "done"] as const;
export type CompletionState = (typeof COMPLETION_STATES)[number];

export function getCompletionStateFromLabels(
  labels: Record<string, unknown> | null | undefined,
): CompletionState | null {
  const value = labels?.[COMPLETION_LABEL];
  return typeof value === "string" && COMPLETION_STATES.includes(value as CompletionState)
    ? (value as CompletionState)
    : null;
}

/** The note, trimmed and cut to the cap, which only `set_completion_state` enforces on write. */
export function getCompletionNoteFromLabels(
  labels: Record<string, unknown> | null | undefined,
): string | null {
  const value = labels?.[COMPLETION_NOTE_LABEL];
  if (typeof value !== "string") {
    return null;
  }
  const note = value.trim().slice(0, COMPLETION_NOTE_MAX_LENGTH);
  return note.length > 0 ? note : null;
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
