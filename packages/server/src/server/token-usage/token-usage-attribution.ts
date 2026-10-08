import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { SessionIndexEntry } from "./token-usage-store.js";

/**
 * Which role a transcript's session books under (docs/token-usage.md): a Paseo agent with no
 * parent agent is a leader, one with a parent is a worker, and a session no agent owns is
 * outside Paseo. The structure is all that is on disk; the classifier's finer role is not
 * persisted, so it cannot be reconstructed for history.
 *
 * `TokenUsageInternalRole` is a closed union on purpose, separate from the protocol's
 * `TokenUsageRole` (an open string — docs/protocol-compatibility.md, never narrow a wire enum).
 * The server only ever produces these three values; the open string on the wire is so a future
 * daemon can add a fourth role without failing validation on an older app.
 */
export type TokenUsageInternalRole = "leader" | "worker" | "outside";

/** The fields of an agent record (stored or live) that name its provider sessions. */
export interface AgentSessionSource {
  id: string;
  labels?: Record<string, string> | null;
  updatedAt?: string | Date | null;
  persistence?: { sessionId?: string | null; nativeHandle?: unknown } | null;
  runtimeInfo?: { sessionId?: string | null } | null;
}

/**
 * A session nobody claims yet is left unread this long after its transcript started: a Paseo
 * agent writes its transcript before its record names the session, and booking those first
 * minutes as outside would be wrong for good.
 */
export const UNKNOWN_SESSION_GRACE_MS = 10 * 60_000;

export function sessionIdsOf(agent: AgentSessionSource): string[] {
  const ids = new Set<string>();
  for (const value of [
    agent.persistence?.sessionId,
    agent.persistence?.nativeHandle,
    agent.runtimeInfo?.sessionId,
  ]) {
    if (typeof value === "string" && value.length > 0) ids.add(value);
  }
  return [...ids];
}

export function roleOfParent(parentAgentId: string | null): TokenUsageInternalRole {
  return parentAgentId === null ? "leader" : "worker";
}

/**
 * Session id to role, from every agent record and the session index. When two sources name the
 * same session (an agent moved between accounts shares its transcript), the newest wins.
 */
export function buildSessionRoles(input: {
  records: readonly AgentSessionSource[];
  sessions: readonly SessionIndexEntry[];
}): Map<string, TokenUsageInternalRole> {
  const newest = new Map<string, { role: TokenUsageInternalRole; atMs: number }>();
  const offer = (sessionId: string, role: TokenUsageInternalRole, atMs: number) => {
    const current = newest.get(sessionId);
    if (!current || atMs >= current.atMs) newest.set(sessionId, { role, atMs });
  };
  for (const entry of input.sessions) {
    offer(entry.sessionId, roleOfParent(entry.parentAgentId), entry.lastSeenMs);
  }
  for (const record of input.records) {
    const role = roleOfParent(getParentAgentIdFromLabels(record.labels));
    const atMs = timeOf(record.updatedAt);
    for (const sessionId of sessionIdsOf(record)) offer(sessionId, role, atMs);
  }
  return new Map([...newest].map(([sessionId, { role }]) => [sessionId, role]));
}

/** The role to book under, or "defer" for a young session no agent claims yet. */
export function resolveRole(input: {
  sessionId: string | null;
  roles: ReadonlyMap<string, TokenUsageInternalRole>;
  fileStartedMs: number;
  nowMs: number;
  graceMs?: number;
}): TokenUsageInternalRole | "defer" {
  const known = input.sessionId ? input.roles.get(input.sessionId) : undefined;
  if (known) return known;
  const graceMs = input.graceMs ?? UNKNOWN_SESSION_GRACE_MS;
  return input.nowMs - input.fileStartedMs < graceMs ? "defer" : "outside";
}

function timeOf(value: string | Date | null | undefined): number {
  if (value instanceof Date) return value.getTime();
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}
