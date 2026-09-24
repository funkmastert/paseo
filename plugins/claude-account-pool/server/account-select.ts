import { rankByHeadroom, type HeadroomHealth } from "./headroom";
import { relevantWindows, type HealthTracker } from "./health";

/**
 * The account half of "what should this agent be", extracted from
 * server/router.ts so it can be answered without running the create hook.
 *
 * Everything time-dependent about the decision is the `nowMs` argument:
 * headroom scoring projects a window's usage against its reset, so the same
 * pool and the same readings place the same way for a given instant and
 * replay identically (see headroom.ts). Nothing here reads the clock, opens
 * a socket, or fires an episode — router.ts still owns the pool-dry,
 * collapse, exhaustion and fail-open reporting built on top of this answer,
 * and server/classifier.ts reads the same answer to explain it.
 */

export type AccountSelectHealth = Pick<
  HealthTracker,
  "isHealthyFor" | "isLastResortEligible" | "isHealthyForAllWindows"
> &
  HeadroomHealth;

export interface AccountPoolWorker {
  providerId: string;
  /** The operator's configured order, used only to break a headroom tie. */
  priority: number;
}

export interface AccountPool {
  workers: readonly AccountPoolWorker[];
  leader: { providerId: string } | null;
}

/**
 * Where the selection ladder landed.
 *
 * - `worker` — isolation held: a pooled worker runs it.
 * - `leader` — no worker could, so the leader account serves it. Isolation is
 *   gone; router.ts raises a pool-dry episode here.
 * - `no-leader` — no usable worker AND no configured leader. The pool is
 *   unfinished rather than exhausted, so router.ts fails open.
 * - `exhausted` — a leader exists and nothing in the pool can run this.
 */
export type AccountSelection =
  | { kind: "worker"; providerId: string }
  | { kind: "leader"; providerId: string }
  | { kind: "no-leader" }
  | { kind: "exhausted"; providerIds: string[] };

/** Every pool entry id, workers then leader, in a stable order. */
export function poolMemberIds(pool: AccountPool): string[] {
  const ids = pool.workers.map((worker) => worker.providerId);
  if (pool.leader) {
    ids.push(pool.leader.providerId);
  }
  return ids;
}

/**
 * Whether an account can serve a request for `modelId`.
 *
 * An empty `modelId` means the request named no model. A model-scoped cap
 * can't be matched against an unknown model, so it must disqualify: the
 * account has to be healthy on every window we've observed.
 */
export function isAccountHealthy(health: AccountSelectHealth, providerId: string, modelId: string): boolean {
  return modelId ? health.isHealthyFor(providerId, modelId) : health.isHealthyForAllWindows(providerId);
}

/** The pool entries that could serve this request at all — healthy, or drained but not capped. */
export function usablePoolMembers(pool: AccountPool, health: AccountSelectHealth, modelId: string): string[] {
  return poolMemberIds(pool).filter(
    (providerId) => isAccountHealthy(health, providerId, modelId) || health.isLastResortEligible(providerId),
  );
}

/**
 * The selection ladder. Tiers rank isolation and health; headroom ranks
 * within a tier, so the account with the most room left absorbs the next
 * spawn instead of whichever one the operator happened to number first:
 *
 *   1. a worker healthy for the requested model;
 *   2. a worker that is drained but not capped — still isolation;
 *   3. the leader, if it can run anything;
 *   4. nothing.
 *
 * 1 is kept above 2 rather than merged into one headroom ranking: a drained
 * worker has less room than a healthy one by definition, and letting a score
 * put a nearly-capped account ahead of a healthy one would trade the pool's
 * purpose for a rounding difference.
 */
export function selectPoolAccount(
  pool: AccountPool,
  health: AccountSelectHealth,
  modelId: string,
  nowMs: number,
): AccountSelection {
  const isHealthy = (providerId: string): boolean => isAccountHealthy(health, providerId, modelId);
  const rank = <T extends AccountPoolWorker>(candidates: readonly T[]): T[] =>
    rankByHeadroom(candidates, health, modelId, nowMs);

  const healthyWorkers = rank(pool.workers.filter((worker) => isHealthy(worker.providerId)));
  const drainedWorkers = rank(
    pool.workers.filter((worker) => !isHealthy(worker.providerId) && health.isLastResortEligible(worker.providerId)),
  );
  const worker = healthyWorkers[0] ?? drainedWorkers[0];
  if (worker) {
    return { kind: "worker", providerId: worker.providerId };
  }

  const leaderUsable =
    pool.leader !== null && (isHealthy(pool.leader.providerId) || health.isLastResortEligible(pool.leader.providerId));
  if (pool.leader && leaderUsable) {
    return { kind: "leader", providerId: pool.leader.providerId };
  }
  if (!pool.leader) {
    return { kind: "no-leader" };
  }
  return { kind: "exhausted", providerIds: poolMemberIds(pool) };
}

/** A window at its cap, and when it comes back if the source said. */
export interface CappedWindow {
  window: string;
  resetsAt?: Date;
}

/**
 * The window that stops `providerId` from running `modelId` at all, or undefined when none does.
 *
 * Only a window AT its cap counts. A drained account can still run the request, and a root's
 * choice of account is respected while it can. With no model named, a model-scoped cap can't be
 * matched against the model that will actually run, so any capped window counts — the same
 * convention `isAccountHealthy` uses.
 */
export function cappedWindowFor(
  health: AccountSelectHealth,
  providerId: string,
  modelId: string,
): CappedWindow | undefined {
  const windows = modelId ? relevantWindows(modelId) : health.windowIds(providerId);
  for (const window of windows) {
    const state = health.describeWindow(providerId, window);
    if (state?.status === "capped") {
      return state.resetsAt ? { window, resetsAt: state.resetsAt } : { window };
    }
  }
  return undefined;
}

/**
 * Where a ROOT agent lands.
 *
 * - `not-pooled` — it asked for a provider the pool doesn't own; the pool has no say.
 * - `kept` — its own account can run it, so it stays there. Isolation is a preference, and a
 *   root's chosen account is respected whenever it can serve.
 * - `rerouted` — its own account is at a cap, so it starts on `providerId` instead.
 * - `stranded` — nothing in the pool can run it. A root is never refused (that would lock the
 *   person out of their own daemon), so it keeps its account and fails on its first turn.
 */
export type RootAccountSelection =
  | { kind: "not-pooled" }
  | { kind: "kept"; providerId: string }
  | { kind: "rerouted"; from: string; blockedBy: CappedWindow; providerId: string; target: "leader" | "worker" }
  | { kind: "stranded"; providerId: string; blockedBy: CappedWindow; providerIds: string[] };

/**
 * The root ladder. A root agent is a leader by definition, so the leader account comes first
 * whenever it can run the request, and only then a worker, ranked the same way a child's is:
 *
 *   0. the account it asked for, if that account can run it at all;
 *   1. the leader account;
 *   2. a worker healthy for the requested model, most headroom first;
 *   3. a worker that is drained but not capped;
 *   4. nothing: it keeps the account it asked for.
 */
export function selectRootAccount(
  pool: AccountPool,
  health: AccountSelectHealth,
  requestedProviderId: string,
  modelId: string,
  nowMs: number,
): RootAccountSelection {
  const members = poolMemberIds(pool);
  if (!members.includes(requestedProviderId)) {
    return { kind: "not-pooled" };
  }
  const blockedBy = cappedWindowFor(health, requestedProviderId, modelId);
  if (!blockedBy) {
    return { kind: "kept", providerId: requestedProviderId };
  }

  const canServe = (providerId: string): boolean =>
    providerId !== requestedProviderId && cappedWindowFor(health, providerId, modelId) === undefined;
  const rerouted = (providerId: string, target: "leader" | "worker"): RootAccountSelection => ({
    kind: "rerouted",
    from: requestedProviderId,
    blockedBy,
    providerId,
    target,
  });

  if (pool.leader && canServe(pool.leader.providerId)) {
    return rerouted(pool.leader.providerId, "leader");
  }
  const candidates = pool.workers.filter((worker) => canServe(worker.providerId));
  const healthy = rankByHeadroom(
    candidates.filter((worker) => isAccountHealthy(health, worker.providerId, modelId)),
    health,
    modelId,
    nowMs,
  );
  const drained = rankByHeadroom(
    candidates.filter((worker) => !isAccountHealthy(health, worker.providerId, modelId)),
    health,
    modelId,
    nowMs,
  );
  const worker = healthy[0] ?? drained[0];
  if (worker) {
    return rerouted(worker.providerId, "worker");
  }
  return { kind: "stranded", providerId: requestedProviderId, blockedBy, providerIds: members };
}

function describeCap(providerId: string, blockedBy: CappedWindow, modelId: string): string {
  const until = blockedBy.resetsAt ? ` until ${blockedBy.resetsAt.toISOString()}` : "";
  return `${providerId} is out of budget for ${modelId || "this request"} (its ${blockedBy.window} window is at its cap${until})`;
}

/**
 * The one sentence for a root's account decision. Shared by the create hook's episode
 * (server/router.ts) and the classifier's explanation (server/classifier.ts), so the log line
 * and the settings preview can't say different things.
 */
export function describeRootSelection(selection: RootAccountSelection, requestedProviderId: string, modelId: string): string {
  switch (selection.kind) {
    case "not-pooled":
      return `A root agent keeps the account it was started on, and ${requestedProviderId} is not a pooled account.`;
    case "kept":
      return `A root agent keeps the account it was started on while that account can serve it, and ${selection.providerId} can run ${modelId || "this request"}.`;
    case "rerouted":
      return selection.target === "leader"
        ? `${describeCap(selection.from, selection.blockedBy, modelId)}, so this root agent starts on the leader account ${selection.providerId} instead. A root keeps the account it was started on only while that account can serve it.`
        : `${describeCap(selection.from, selection.blockedBy, modelId)} and the leader account can't run it either, so this root agent starts on ${selection.providerId}, the pooled worker with the most headroom. A root keeps the account it was started on only while that account can serve it.`;
    case "stranded":
      return `${describeCap(selection.providerId, selection.blockedBy, modelId)}, and so is every other pooled account (${selection.providerIds.join(", ")}). A root agent is never refused, so it keeps ${selection.providerId} and will fail until a window resets.`;
  }
}
