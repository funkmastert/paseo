import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkItem } from "@getpaseo/protocol/coordination/queue-schemas";
import type { StreamEntry } from "@getpaseo/protocol/coordination/stream-schemas";
import { toErrorMessage } from "@/utils/error-messages";
import type { AggregatedStreamEntry, AggregatedWorkItem } from "./model";

export const inboxQueryBaseKey = ["inbox"] as const;

export const ALL_INBOX_HOSTS_FAILED_MESSAGE = "No connected hosts could load the Inbox";

/** Pages via the existing cursors (docs/work-queue.md#storage), bounded so a runaway stream or
 * backlog cannot loop forever against one host. */
const MAX_PAGES_PER_HOST = 10;
const PAGE_LIMIT = 200;

export interface InboxHostInput {
  serverId: string;
  serverName: string;
}

export interface InboxRuntimeSnapshot {
  connectionStatus: string;
}

export interface InboxRuntime {
  getClient(
    serverId: string,
  ): Pick<DaemonClient, "coordinationQueueList" | "coordinationStreamList"> | null;
  getSnapshot(serverId: string): InboxRuntimeSnapshot | null | undefined;
}

export interface InboxHostError {
  serverId: string;
  serverName: string;
  message: string;
}

export interface FetchAggregatedInboxConnectingResult {
  status: "connecting";
}

export interface FetchAggregatedInboxResult {
  status: "loaded";
  requests: AggregatedWorkItem[];
  updates: AggregatedStreamEntry[];
  hostErrors: InboxHostError[];
}

export type FetchAggregatedInboxState =
  | FetchAggregatedInboxConnectingResult
  | FetchAggregatedInboxResult;

export interface FetchAggregatedInboxInput {
  hosts: readonly InboxHostInput[];
  runtime: InboxRuntime;
}

/**
 * Fetches the Inbox across connected, coordination-capable hosts (the caller filters to those):
 * open items owned by `human`, and the fleet stream. Mirrors
 * schedules/aggregated-schedules.ts — offline hosts are skipped, a connected host that fails
 * contributes to `hostErrors` while the rest still render, and only when every connected host
 * fails do we throw so the screen shows a full error.
 */
export async function fetchAggregatedInbox(
  input: FetchAggregatedInboxInput,
): Promise<FetchAggregatedInboxState> {
  const hasSettlingHost = input.hosts.some((host) =>
    isInboxHostConnectionSettling(input.runtime.getSnapshot(host.serverId)),
  );
  const hasAskableHost = input.hosts.some((host) => {
    const snapshot = input.runtime.getSnapshot(host.serverId);
    return snapshot?.connectionStatus === "online" && input.runtime.getClient(host.serverId);
  });

  if (!hasAskableHost && hasSettlingHost) {
    return { status: "connecting" };
  }

  const requests: AggregatedWorkItem[] = [];
  const updates: AggregatedStreamEntry[] = [];
  const hostErrors: InboxHostError[] = [];
  let connectedAttempts = 0;

  await Promise.all(
    input.hosts.map(async (host) => {
      const snapshot = input.runtime.getSnapshot(host.serverId);
      const isOnline = snapshot?.connectionStatus === "online";
      const client = input.runtime.getClient(host.serverId);
      if (!client || !isOnline) {
        return;
      }
      connectedAttempts += 1;
      try {
        const [items, entries] = await Promise.all([
          fetchAllHumanRequests(client),
          fetchAllStreamEntries(client),
        ]);
        for (const item of items) {
          requests.push({ ...item, serverId: host.serverId, serverName: host.serverName });
        }
        for (const entry of entries) {
          updates.push({ ...entry, serverId: host.serverId, serverName: host.serverName });
        }
      } catch (error) {
        hostErrors.push({
          serverId: host.serverId,
          serverName: host.serverName,
          message: toErrorMessage(error),
        });
      }
    }),
  );

  if (
    connectedAttempts > 0 &&
    requests.length === 0 &&
    updates.length === 0 &&
    hostErrors.length === connectedAttempts
  ) {
    throw new Error(ALL_INBOX_HOSTS_FAILED_MESSAGE);
  }

  if (requests.length === 0 && updates.length === 0 && hasSettlingHost) {
    return { status: "connecting" };
  }

  return { status: "loaded", requests, updates, hostErrors };
}

async function fetchAllHumanRequests(
  client: Pick<DaemonClient, "coordinationQueueList">,
): Promise<WorkItem[]> {
  const items: WorkItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES_PER_HOST; page += 1) {
    const result = await client.coordinationQueueList({
      filter: { owner: "human", openOnly: true, limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    if (result.error) throw new Error(result.error);
    items.push(...(result.items ?? []));
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return items;
}

async function fetchAllStreamEntries(
  client: Pick<DaemonClient, "coordinationStreamList">,
): Promise<StreamEntry[]> {
  const entries: StreamEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES_PER_HOST; page += 1) {
    const result = await client.coordinationStreamList({
      filter: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    if (result.error) throw new Error(result.error);
    entries.push(...(result.entries ?? []));
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return entries;
}

function isInboxHostConnectionSettling(snapshot: InboxRuntimeSnapshot | null | undefined): boolean {
  if (!snapshot) {
    return true;
  }
  return snapshot.connectionStatus === "connecting" || snapshot.connectionStatus === "idle";
}
