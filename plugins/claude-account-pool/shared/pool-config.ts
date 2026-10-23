import { z } from "zod";

/**
 * Per-provider-entry pool metadata, stored at
 * `agents.providers.<id>.params.accountPool` in daemon config.
 */
export const AccountPoolRoleSchema = z.enum(["leader", "worker"]);
export type AccountPoolRole = z.infer<typeof AccountPoolRoleSchema>;

export const AccountPoolEntrySchema = z.object({
  role: AccountPoolRoleSchema,
  priority: z.number().int().positive(),
});
export type AccountPoolEntry = z.infer<typeof AccountPoolEntrySchema>;

/** Shape of a provider entry's `params` field once it carries pool metadata. */
export const ProviderAccountPoolParamsSchema = z
  .object({ accountPool: AccountPoolEntrySchema })
  .passthrough();
export type ProviderAccountPoolParams = z.infer<typeof ProviderAccountPoolParamsSchema>;

/** One provider config entry, keyed by its provider id, carrying pool metadata. */
export interface PoolProviderEntry {
  providerId: string;
  accountPool: AccountPoolEntry;
}

/** A worker in preference order: index 0 is the most preferred target. */
export interface ResolvedWorker {
  providerId: string;
  priority: number;
}

/** The last-resort target and notification anchor. */
export interface ResolvedLeader {
  providerId: string;
}

export interface ResolvedPool {
  /** Ordered ascending by priority: most preferred worker first. */
  workers: ResolvedWorker[];
  /** Exactly one leader entry, or null when none is configured. */
  leader: ResolvedLeader | null;
}

export const EMPTY_POOL: ResolvedPool = { workers: [], leader: null };

export class PoolConfigError extends Error {}

/**
 * Resolves a set of validated provider pool entries into an ordered worker
 * chain and a single leader. Throws PoolConfigError for duplicate worker
 * priorities or more than one leader; callers decide how to fail open.
 */
export function resolvePool(entries: readonly PoolProviderEntry[]): ResolvedPool {
  const leaders = entries.filter((entry) => entry.accountPool.role === "leader");
  if (leaders.length > 1) {
    throw new PoolConfigError(
      `accountPool config must declare exactly one leader, found ${leaders.length}: ${leaders
        .map((leader) => leader.providerId)
        .join(", ")}`,
    );
  }

  const workers = entries.filter((entry) => entry.accountPool.role === "worker");
  const priorityOwners = new Map<number, string>();
  for (const worker of workers) {
    const priority = worker.accountPool.priority;
    const owner = priorityOwners.get(priority);
    if (owner !== undefined) {
      throw new PoolConfigError(
        `accountPool worker priority ${priority} is used by both "${owner}" and "${worker.providerId}"; worker priorities must be unique`,
      );
    }
    priorityOwners.set(priority, worker.providerId);
  }

  const sortedWorkers = [...workers]
    .sort((a, b) => a.accountPool.priority - b.accountPool.priority)
    .map((worker) => ({ providerId: worker.providerId, priority: worker.accountPool.priority }));

  const leader = leaders[0] ? { providerId: leaders[0].providerId } : null;

  return { workers: sortedWorkers, leader };
}
