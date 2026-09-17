import type { PluginHookContext } from "@getpaseo/plugin/server";
import type { CapEvent, HealthTracker } from "./health";
import type { FailOpenEpisode, PoolDryEpisode } from "./router";

export type { FailOpenEpisode, PoolDryEpisode } from "./router";

/** The subset of PaseoApi this module needs: listing and messaging agents. */
export type NotifierPaseoApi = Pick<PluginHookContext["paseo"], "agents">;

export interface NotifierOptions {
  paseo: NotifierPaseoApi;
  health: Pick<HealthTracker, "onChange">;
  /**
   * Defers work off the calling stack so notification sends never happen
   * synchronously inside a lifecycle hook dispatch. Defaults to
   * queueMicrotask; tests inject a controllable queue.
   */
  schedule?: (fn: () => void | Promise<void>) => void;
  /**
   * Injectable clock for tests; defaults to `() => new Date()`. Drives the
   * resetsAt-in-the-past check that drops a stale cap notification at
   * delivery time (e.g. one held behind a pending permission until well
   * after its window already reset).
   */
  now?: () => Date;
}

export interface Notifier {
  /** Router calls this when it fell back to the leader because every worker was unhealthy. */
  notePoolDry(episode: PoolDryEpisode): void;
  /** Router calls this whenever it fails open. */
  noteFailOpen(episode: FailOpenEpisode): void;
  /** Router calls this when the pool cache recovers from fail-open, re-arming fail-open episodes. */
  notePoolRecovered(): void;
  /** Wire to the agent.permission_requested lifecycle event. */
  /** Wire to the agent.created lifecycle event: a leader whose creation this
   * notifier observed is steer-safe from birth (it cannot carry a pending
   * permission the notifier never saw), so the turn-boundary hold applies
   * only to agents that pre-date the notifier (e.g. across a plugin reload). */
  onAgentCreated(agentId: string): void;
  onPermissionRequested(agentId: string): void;
  /** Wire to the agent.permission_resolved lifecycle event. */
  onPermissionResolved(agentId: string): void;
  /** Wire to the agent.turn_ended lifecycle event: flushes anything held for retry. */
  onTurnEnded(agentId: string): void;
  /** Wire to the agent.archived lifecycle event: prunes all per-agent notifier state. */
  onAgentArchived(agentId: string): void;
  /** Unsubscribes from the health tracker. Safe to call more than once. */
  stop(): void;
}

/** Mirrors the daemon's AgentLifecycleStatus enum (protocol/agent-lifecycle.ts). */
type AgentLifecycleStatus = "initializing" | "idle" | "running" | "error" | "closed";

interface AgentDirectoryRow {
  id: string;
  parentAgentId: string | null;
  title: string | null;
  provider: string;
  archived: boolean;
  status: AgentLifecycleStatus;
}

interface QueuedSend {
  leaderId: string;
  text: string;
  /** Cap-notification-only: the window's reset time, re-checked at delivery time. */
  resetsAt?: Date;
}

// The daemon's agent list payload does not carry a structural
// `parentAgentId` property; parentage travels in the row's `labels` record
// under this key instead (labels are forwarded on the wire). This mirrors
// the daemon's own PARENT_AGENT_ID_LABEL constant. The structural property
// is still checked first so this keeps working if a future daemon adds it.
const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

function resolveParentAgentId(agent: {
  parentAgentId?: string | null;
  labels?: Record<string, unknown> | null;
}): string | null {
  // TYPE NOTE: neither parentAgentId nor labels is on the installed
  // @getpaseo/client AgentSnapshotPayload type yet; the daemon adds both to
  // agent directory rows at runtime, mirroring the callerAgentId accepted on
  // creation. Read them structurally rather than forking the SDK types.
  if (typeof agent.parentAgentId === "string" && agent.parentAgentId.length > 0) {
    return agent.parentAgentId;
  }
  const fromLabel = agent.labels?.[PARENT_AGENT_ID_LABEL];
  return typeof fromLabel === "string" && fromLabel.length > 0 ? fromLabel : null;
}

async function listAgentDirectory(paseo: NotifierPaseoApi): Promise<AgentDirectoryRow[]> {
  const result = await paseo.agents.list();
  return result.entries.map((entry) => {
    const agent = entry.agent;
    return {
      id: agent.id,
      parentAgentId: resolveParentAgentId(agent),
      title: agent.title,
      provider: agent.provider,
      archived: agent.archivedAt != null,
      status: agent.status,
    };
  });
}

type AgentDirectoryIndex = Map<string, AgentDirectoryRow>;

function buildAgentDirectoryIndex(rows: AgentDirectoryRow[]): AgentDirectoryIndex {
  return new Map(rows.map((row) => [row.id, row]));
}

/** Walks parentAgentId up from startAgentId to the root agent with no parent. */
function resolveRootLeader(byId: AgentDirectoryIndex, startAgentId: string): AgentDirectoryRow | null {
  let current = byId.get(startAgentId);
  if (!current) {
    return null;
  }
  const seen = new Set<string>();
  while (current.parentAgentId) {
    if (seen.has(current.id)) {
      break; // Cycle guard; should never happen against real directory data.
    }
    seen.add(current.id);
    const parent = byId.get(current.parentAgentId);
    if (!parent) {
      break;
    }
    current = parent;
  }
  return current;
}

/**
 * A row counts as "affected" by a cap only if its session is still live on
 * the daemon at the time we list the directory: not archived, and not
 * `closed` (the daemon's terminal status once a session has fully exited).
 * `error`/`idle`/`running`/`initializing` all still count — in particular
 * the reactive path (a turn failure classified as a cap) fires *because* an
 * agent's turn just errored, so excluding `error` would drop the very agent
 * that triggered detection. `closed` is the only status that means the
 * session itself is gone, which is what made the real incident this fixes
 * misleading: four long-`closed` agents were named as "running there" for
 * a cap event the daemon only rediscovered later, on a fresh usage poll.
 */
function isAffectedByCapRow(row: AgentDirectoryRow): boolean {
  return !row.archived && row.status !== "closed";
}

/** Groups agents live on `providerId` at listing time by their resolved root leader. */
function groupAffectedChildrenByLeader(
  byId: AgentDirectoryIndex,
  providerId: string,
): Map<string, { leader: AgentDirectoryRow; children: AgentDirectoryRow[] }> {
  const byLeader = new Map<string, { leader: AgentDirectoryRow; children: AgentDirectoryRow[] }>();
  for (const row of byId.values()) {
    if (row.provider !== providerId || !isAffectedByCapRow(row)) {
      continue;
    }
    const leader = resolveRootLeader(byId, row.id);
    if (!leader || leader.id === row.id) {
      continue; // No resolvable leader, or the row is itself a root (not a routed child).
    }
    let bucket = byLeader.get(leader.id);
    if (!bucket) {
      bucket = { leader, children: [] };
      byLeader.set(leader.id, bucket);
    }
    bucket.children.push(row);
  }
  return byLeader;
}

function describeChild(row: AgentDirectoryRow): string {
  return `${row.title ?? "untitled"} (${row.id})`;
}

function formatCapMessage(event: CapEvent, children: AgentDirectoryRow[]): string {
  const resetPart = event.resetsAt ? ` It resets at ${event.resetsAt.toISOString()}.` : "";
  const childList = children.map(describeChild).join(", ");
  return (
    `Account pool: provider "${event.providerId}" hit its "${event.window}" limit.${resetPart} ` +
    `Affected children that were running there: ${childList}.`
  );
}

function formatPoolDryMessage(episode: PoolDryEpisode): string {
  return (
    `Account pool: every worker is capped for model "${episode.requestedModel}". ` +
    `New spawns are falling back to the leader account "${episode.leaderProviderId}".`
  );
}

function formatFailOpenMessage(episode: FailOpenEpisode): string {
  const target = episode.targetProviderId ? ` (target "${episode.targetProviderId}")` : "";
  return (
    `Account pool: routing failed open (${episode.reason}${target}). ` +
    `Requests are proceeding without pool routing until this clears.`
  );
}

export function createNotifier(options: NotifierOptions): Notifier {
  const { paseo, health } = options;
  const schedule = options.schedule ?? ((fn: () => void | Promise<void>) => queueMicrotask(fn));
  const now = options.now ?? (() => new Date());

  const poolDryNotifiedLeaders = new Set<string>();
  const failOpenNotifiedLeaders = new Set<string>();
  const pendingPermissionCounts = new Map<string, number>();
  const heldSends = new Map<string, QueuedSend[]>();
  // Leaders for which this notifier instance has seen a turn boundary
  // (turn_ended or permission_resolved). A fresh instance (e.g. after a plugin
  // reload) knows nothing about in-flight permission prompts, so steering is
  // withheld until a boundary proves the leader is safe to steer.
  const boundaryObservedLeaders = new Set<string>();

  function hasPendingPermission(agentId: string): boolean {
    return (pendingPermissionCounts.get(agentId) ?? 0) > 0;
  }

  function queueHeld(leaderId: string, text: string, resetsAt?: Date): void {
    const list = heldSends.get(leaderId) ?? [];
    list.push({ leaderId, text, resetsAt });
    heldSends.set(leaderId, list);
  }

  async function deliver(leaderId: string, text: string, resetsAt?: Date): Promise<void> {
    if (resetsAt && resetsAt.getTime() <= now().getTime()) {
      // The window this notification was about already reset — e.g. it sat
      // behind a pending permission (or a rejected steer) until after
      // resetsAt passed. Drop it rather than deliver a stale duplicate.
      console.debug(
        `[claude-account-pool] notify: dropping stale cap notification for leader "${leaderId}" (resetsAt ${resetsAt.toISOString()} already passed)`,
      );
      return;
    }
    if (!boundaryObservedLeaders.has(leaderId) || hasPendingPermission(leaderId)) {
      queueHeld(leaderId, text, resetsAt);
      return;
    }
    try {
      const handle = paseo.agents.ref(leaderId);
      // TYPE NOTE: activeTurnBehavior isn't on the installed @getpaseo/client
      // PaseoAgentSendOptions type yet; the daemon adds runtime support for
      // steering an active turn. Cast structurally rather than forking the
      // SDK types.
      await handle.send(text, { activeTurnBehavior: "steer" } as unknown as Parameters<typeof handle.send>[1]);
    } catch {
      queueHeld(leaderId, text, resetsAt); // Retried on this leader's next turn_ended.
    }
  }

  function flushHeld(leaderId: string): void {
    const list = heldSends.get(leaderId);
    if (!list || list.length === 0) {
      return;
    }
    heldSends.delete(leaderId);
    for (const item of list) {
      schedule(() => deliver(item.leaderId, item.text, item.resetsAt));
    }
  }

  async function safeListDirectory(): Promise<AgentDirectoryRow[] | null> {
    try {
      return await listAgentDirectory(paseo);
    } catch (error) {
      console.error("[claude-account-pool] notify: failed to list agents for a notification", error);
      return null;
    }
  }

  // Serializes the process* functions so two episodes for the same leader
  // can't interleave across their internal awaits and both pass the
  // once-per-episode check.
  let processingTail: Promise<void> = Promise.resolve();
  function enqueue(fn: () => Promise<void>): Promise<void> {
    const result = processingTail.then(fn);
    processingTail = result.catch(() => {});
    return result;
  }

  async function processPoolDry(episode: PoolDryEpisode): Promise<void> {
    const rows = await safeListDirectory();
    if (!rows) {
      return;
    }
    const leader = resolveRootLeader(buildAgentDirectoryIndex(rows), episode.callerAgentId);
    if (!leader || poolDryNotifiedLeaders.has(leader.id)) {
      return;
    }
    poolDryNotifiedLeaders.add(leader.id);
    await deliver(leader.id, formatPoolDryMessage(episode));
  }

  async function processFailOpen(episode: FailOpenEpisode): Promise<void> {
    const rows = await safeListDirectory();
    if (!rows) {
      return;
    }
    const leader = resolveRootLeader(buildAgentDirectoryIndex(rows), episode.callerAgentId);
    if (!leader || failOpenNotifiedLeaders.has(leader.id)) {
      return;
    }
    failOpenNotifiedLeaders.add(leader.id);
    await deliver(leader.id, formatFailOpenMessage(episode));
  }

  async function processCapped(event: CapEvent): Promise<void> {
    const rows = await safeListDirectory();
    if (!rows) {
      return;
    }
    // A leader whose bucket exists here already has at least one live
    // affected child (groupAffectedChildrenByLeader only creates a bucket
    // for rows that pass isAffectedByCapRow) — so a provider-wide cap with
    // no live affected agents anywhere yields an empty `groups` and steers
    // nobody, rather than surfacing a stale-looking alert into every leader.
    const groups = groupAffectedChildrenByLeader(buildAgentDirectoryIndex(rows), event.providerId);
    await Promise.allSettled(
      Array.from(groups.values()).map(({ leader, children }) =>
        deliver(leader.id, formatCapMessage(event, children), event.resetsAt),
      ),
    );
  }

  const unsubscribeHealth = health.onChange((event: CapEvent) => {
    if (event.kind === "capped") {
      schedule(() => enqueue(() => processCapped(event)));
    } else {
      // A pool account transitioning back to healthy re-arms the pool-dry episode.
      poolDryNotifiedLeaders.clear();
    }
  });

  return {
    notePoolDry(episode) {
      schedule(() => enqueue(() => processPoolDry(episode)));
    },
    noteFailOpen(episode) {
      schedule(() => enqueue(() => processFailOpen(episode)));
    },
    notePoolRecovered() {
      failOpenNotifiedLeaders.clear();
    },
    onAgentCreated(agentId) {
      boundaryObservedLeaders.add(agentId);
    },
    onPermissionRequested(agentId) {
      pendingPermissionCounts.set(agentId, (pendingPermissionCounts.get(agentId) ?? 0) + 1);
    },
    onPermissionResolved(agentId) {
      boundaryObservedLeaders.add(agentId);
      const count = (pendingPermissionCounts.get(agentId) ?? 0) - 1;
      if (count <= 0) {
        pendingPermissionCounts.delete(agentId);
        flushHeld(agentId);
      } else {
        pendingPermissionCounts.set(agentId, count);
      }
    },
    onTurnEnded(agentId) {
      boundaryObservedLeaders.add(agentId);
      flushHeld(agentId);
    },
    onAgentArchived(agentId) {
      // The agent is gone: drop any held sends rather than deliver them, and
      // forget it entirely so its state doesn't linger past archival.
      poolDryNotifiedLeaders.delete(agentId);
      failOpenNotifiedLeaders.delete(agentId);
      pendingPermissionCounts.delete(agentId);
      heldSends.delete(agentId);
      boundaryObservedLeaders.delete(agentId);
    },
    stop() {
      unsubscribeHealth();
    },
  };
}
