import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import type { Agent } from "@/stores/session-store";
import type { OrchestrationFlatRow } from "./orchestration-panel-model";
import { agentStatePriority, compareOrchestrationRoots } from "./orchestration-ordering";

// Inlined rather than imported from @/timeline/turn-liveness: this module is loaded by the
// browser screenshot harness, where every runtime import drags another slice of the app (and
// eventually expo-modules-core, which does not bundle for web) into the test bundle.
const IDLE_TURN: Agent["turn"] = { phase: "idle", cancellationRequestId: null };

export const FIXTURE_SERVER_ID = "fixture-host";

/**
 * A fleet shaped like a real one: measured off a working daemon at 53 unarchived agents —
 * 4 running, 30 idle, 19 closed — spread across several root trees with their subagents nested
 * under them. That ratio is the whole design problem: the handful of agents doing something are
 * outnumbered twelve to one by ones that already finished.
 *
 * Only running agents carry `lastActivitySummary` and `recentTokenRate`. Both are live-only
 * daemon state that is never persisted, so a finished agent's summary is whatever it last did
 * before going quiet, and after a daemon restart nobody has one at all.
 */
export const FIXTURE_NOW_MS = Date.UTC(2026, 8, 18, 23, 52, 0);
const BASE_MS = FIXTURE_NOW_MS;

interface FixtureSpec {
  title: string;
  status: AgentLifecycleStatus;
  ageMinutes: number;
  children?: FixtureSpec[];
  activity?: string;
  tokensPerMinute?: number;
  requiresAttention?: boolean;
  attentionReason?: "finished" | "error" | "permission";
  pendingPermission?: boolean;
  model?: string;
}

const FLEET: FixtureSpec[] = [
  {
    title: "Orchestration panel: staleness then presentation",
    status: "running",
    ageMinutes: 0,
    activity: "[Edit] packages/app/src/panels/orchestration-panel.tsx",
    tokensPerMinute: 79_000,
    children: [
      { title: "Audit every field the panel renders", status: "idle", ageMinutes: 12 },
      { title: "Capture the panel at fleet scale", status: "idle", ageMinutes: 34 },
    ],
  },
  {
    title: "Device lease checkout and status UI",
    status: "running",
    ageMinutes: 0,
    activity: "[Bash] npm run typecheck --workspace=@getpaseo/app",
    tokensPerMinute: 21_000,
    children: [
      {
        title: "Lease expiry banner",
        status: "running",
        ageMinutes: 0,
        activity: "[Read] packages/app/src/screens/devices/lease-card.tsx",
        tokensPerMinute: 18_000,
      },
      { title: "Device lease protocol messages", status: "idle", ageMinutes: 48 },
      { title: "Reap leases whose holder went away", status: "closed", ageMinutes: 93 },
    ],
  },
  {
    title: "Relaunch app on device for pull-to-refresh test",
    status: "running",
    ageMinutes: 0,
    activity: "[Bash] adb -s R5CT30 shell am start -n sh.paseo.dev/.MainActivity",
    tokensPerMinute: 9_400,
    children: [
      {
        title: "Match iOS pull-to-refresh on Android Home",
        status: "idle",
        ageMinutes: 0,
        requiresAttention: true,
        attentionReason: "permission",
        pendingPermission: true,
      },
      { title: "Android: white stripe flash in Home header", status: "closed", ageMinutes: 93 },
      { title: "Diagnose Android post-hot-leads Home scroll", status: "idle", ageMinutes: 189 },
      { title: "Fix Android Files doubled arrow and border", status: "idle", ageMinutes: 201 },
      { title: "Android convo empty-state lift", status: "idle", ageMinutes: 214 },
      { title: "Android: fix deal-update sheet top inset", status: "idle", ageMinutes: 1305 },
      { title: "Android: centre empty state, unavailable row", status: "idle", ageMinutes: 1441 },
    ],
  },
  {
    title: "Move an agent between providers in place",
    status: "idle",
    ageMinutes: 144,
    children: [
      { title: "Move an agent without re-import", status: "idle", ageMinutes: 173 },
      { title: "Rapid: managed owner lock + real scheduler user", status: "idle", ageMinutes: 151 },
    ],
  },
  {
    title: "Fix pool auth failure detection",
    status: "idle",
    ageMinutes: 163,
    requiresAttention: true,
    attentionReason: "error",
    children: [
      { title: "Pool: explicit model eligibility checks", status: "idle", ageMinutes: 1305 },
      { title: "Close MCP shell escape in agent profiles", status: "idle", ageMinutes: 1307 },
      { title: "Deny destructive tools for read-only roles", status: "idle", ageMinutes: 1301 },
      { title: "Implement role tool profiles and enforcement", status: "idle", ageMinutes: 1310 },
      { title: "Restrict tool profiles: inheritance, browser", status: "idle", ageMinutes: 1304 },
      {
        title: "Fork: system-prompt channel + enforcement guard",
        status: "idle",
        ageMinutes: 1388,
      },
    ],
  },
  {
    title: "Hand back to Wonderly Scheduler (leader)",
    status: "closed",
    ageMinutes: 177,
    children: [
      { title: "Restore durable stale deals testing", status: "idle", ageMinutes: 1302 },
      { title: "MCP gateway: adopt scope + non-DCR OAuth", status: "closed", ageMinutes: 1731 },
    ],
  },
  {
    title: "Fix Paseo account failover logic",
    status: "idle",
    ageMinutes: 342,
    children: [
      { title: "Daemon account failover + plugin resilience", status: "closed", ageMinutes: 4306 },
      { title: "Implement account failover detection", status: "closed", ageMinutes: 4306 },
      {
        title: "Implement plugin dark-routing alert monitoring",
        status: "closed",
        ageMinutes: 4306,
      },
      { title: "Cap notifier: stale agents + repeat alerts", status: "idle", ageMinutes: 1453 },
      { title: "Reap orphaned build daemons, don't just report", status: "idle", ageMinutes: 1399 },
      { title: "Spend governor: graduated enforcement", status: "idle", ageMinutes: 1301 },
    ],
  },
  {
    title: "Walk & Talk Android — #5576 merged",
    status: "idle",
    ageMinutes: 1274,
    children: [
      { title: "[MOVED → session limit] Walk & Talk Android", status: "closed", ageMinutes: 1441 },
      { title: "[MOVED → out of budget] Walk & Talk Android", status: "closed", ageMinutes: 1441 },
      {
        title: "iOS: Conversation empty state + unavailable row",
        status: "idle",
        ageMinutes: 1425,
      },
      { title: "iOS: Conversation empty state (superseded)", status: "closed", ageMinutes: 1450 },
    ],
  },
  {
    title: "Find GitHub PRs missing from Wondergit",
    status: "idle",
    ageMinutes: 1302,
    children: [{ title: "Check Amplitude MCP connectivity", status: "idle", ageMinutes: 1312 }],
  },
  { title: "Set up Amplitude MCP authentication", status: "idle", ageMinutes: 1312 },
  { title: "Build iOS app for Tyler's iPhone", status: "idle", ageMinutes: 1 },
  {
    title: "are you still doing nightly journals and compounding",
    status: "closed",
    ageMinutes: 1713,
  },
  { title: "do you remember the QA projects we worked on", status: "closed", ageMinutes: 2812 },
  {
    title: "after the client intake form there is a confirmation",
    status: "closed",
    ageMinutes: 3030,
  },
  { title: "Capture backend PR stack onto main", status: "closed", ageMinutes: 4306 },
  { title: "Colorful wombat spike", status: "closed", ageMinutes: 4310 },
  { title: "Deal files route", status: "closed", ageMinutes: 4320 },
  { title: "Deal files web", status: "closed", ageMinutes: 4330 },
  { title: "Shiny blowfish", status: "closed", ageMinutes: 4340 },
  { title: "PF join handshake", status: "closed", ageMinutes: 4350 },
];

const CAPABILITIES = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

export function buildOrchestrationFixtureFleet(): Agent[] {
  const agents: Agent[] = [];
  let seq = 0;

  const build = (spec: FixtureSpec, parentAgentId: string | null): void => {
    const id = `fixture-agent-${String(seq++).padStart(2, "0")}`;
    const updatedAt = new Date(BASE_MS - spec.ageMinutes * 60_000);
    agents.push({
      serverId: FIXTURE_SERVER_ID,
      id,
      provider: "claude",
      status: spec.status,
      turn: IDLE_TURN,
      createdAt: new Date(updatedAt.getTime() - 45 * 60_000),
      updatedAt,
      lastUserMessageAt: updatedAt,
      lastActivityAt: updatedAt,
      capabilities: CAPABILITIES,
      currentModeId: "bypassPermissions",
      availableModes: [],
      pendingPermissions: spec.pendingPermission
        ? ([{ id: "req-1", toolName: "Bash", input: {} }] as never)
        : [],
      persistence: null,
      title: spec.title,
      cwd: "/Users/dev/.paseo/worktrees/fixture",
      workspaceId: "wks_fixture",
      model: spec.model ?? "claude-opus-5",
      parentAgentId,
      labels: {},
      ...(spec.activity ? { lastActivitySummary: spec.activity } : {}),
      ...(spec.tokensPerMinute
        ? {
            recentTokenRate: { tokensPerMinute: spec.tokensPerMinute, asOfMs: BASE_MS },
            totalTokens: spec.tokensPerMinute * 5,
          }
        : {}),
      ...(spec.requiresAttention ? { requiresAttention: true } : {}),
      ...(spec.attentionReason ? { attentionReason: spec.attentionReason } : {}),
    });
    for (const child of spec.children ?? []) build(child, id);
  };

  for (const spec of FLEET) build(spec, null);
  return agents;
}

/**
 * The fleet already flattened the way the panel flattens it — depth-first pre-order, each node
 * immediately before its children — so a caller gets the exact row list without importing the
 * panel's model (and the app graph behind it).
 */
export function buildOrchestrationFixtureRows(): OrchestrationFlatRow[] {
  const agents = buildOrchestrationFixtureFleet();
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const childrenByParent = new Map<string, Agent[]>();
  const roots: Agent[] = [];
  for (const agent of agents) {
    if (agent.parentAgentId && byId.has(agent.parentAgentId)) {
      const bucket = childrenByParent.get(agent.parentAgentId);
      if (bucket) bucket.push(agent);
      else childrenByParent.set(agent.parentAgentId, [agent]);
    } else {
      roots.push(agent);
    }
  }

  const requiresAttentionInSubtree = (agent: Agent): boolean =>
    Boolean(agent.requiresAttention) ||
    (childrenByParent.get(agent.id) ?? []).some(requiresAttentionInSubtree);

  const subtreePriority = (agent: Agent): number =>
    Math.min(
      agentStatePriority(agent),
      ...(childrenByParent.get(agent.id) ?? []).map(subtreePriority),
    );

  const rows: OrchestrationFlatRow[] = [];
  const visit = (agent: Agent, depth: number): void => {
    const children = childrenByParent.get(agent.id) ?? [];
    rows.push({
      agent,
      depth,
      descendantRequiresAttention: children.some(requiresAttentionInSubtree),
    });
    for (const child of children) visit(child, depth + 1);
  };
  const orderedRoots = roots
    .map((agent) => ({ agent, subtreePriority: subtreePriority(agent) }))
    .sort(compareOrchestrationRoots);
  for (const root of orderedRoots) visit(root.agent, 0);
  return rows;
}

/**
 * The rows of one root's tree, as the panel's scoped flatten would produce them: a root and the
 * contiguous run of deeper rows that follows it in the pre-order list.
 */
export function sliceOrchestrationFixtureTree(
  rows: readonly OrchestrationFlatRow[],
  rootTitle: string,
): OrchestrationFlatRow[] {
  const start = rows.findIndex((row) => row.depth === 0 && row.agent.title === rootTitle);
  if (start < 0) return [];
  let end = start + 1;
  while (end < rows.length && (rows[end]?.depth ?? 0) > 0) end += 1;
  return rows.slice(start, end);
}
