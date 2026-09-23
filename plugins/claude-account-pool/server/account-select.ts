import { rankByHeadroom, type HeadroomHealth } from "./headroom";
import type { HealthTracker } from "./health";

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
