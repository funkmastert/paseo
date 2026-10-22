import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  CompactionEpisode,
  CompactionEpisodesSummary,
} from "@getpaseo/protocol/compaction/rpc-schemas";
import { useCallback, useMemo, useState } from "react";
import { useFetchQueries, useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export type { CompactionEpisode, CompactionEpisodesSummary };

/** The wire's `range` is an open string (docs/protocol-compatibility.md); this is what the daemon
 * actually serves (`compaction-session.ts`'s `compactionRange`). */
export type CompactionRange = "today" | "7d" | "all";

/** Polled while the Insights screen is focused, matching the JEV dashboard's cadence. */
export const COMPACTION_EPISODES_POLL_MS = 30 * 1000;

interface CompactionEpisodesPage {
  episodes: CompactionEpisode[];
  nextCursor: string | null;
}

export function compactionEpisodesSummaryQueryKey(
  serverId: string | null | undefined,
  range: CompactionRange,
  agentId: string | undefined,
) {
  return ["compactionEpisodesSummary", serverId ?? "", range, agentId ?? ""] as const;
}

export function compactionEpisodesListQueryKey(
  serverId: string | null | undefined,
  query: { range: CompactionRange; agentId?: string },
) {
  return ["compactionEpisodesList", serverId ?? "", query.range, query.agentId ?? ""] as const;
}

/** `compaction.episodes.summary` for a range, gated on `server_info.features.compactionLedger`. */
export function useCompactionEpisodesSummary(
  serverId: string | null | undefined,
  range: CompactionRange,
  agentId: string | undefined,
  options: { enabled?: boolean } = {},
): { data: CompactionEpisodesSummary | undefined; isLoading: boolean; isSupported: boolean } {
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const isSupported = useHostFeature(serverId, "compactionLedger");
  const enabled = Boolean(
    (options.enabled ?? true) && serverId && client && isConnected && isSupported,
  );

  const queryFn = useCallback(async () => {
    if (!client) throw new Error("compaction episodes summary requested without a host client");
    return (await client.compactionEpisodesSummary({ range, agentId })).summary;
  }, [client, range, agentId]);

  const query = useFetchQuery({
    queryKey: compactionEpisodesSummaryQueryKey(serverId, range, agentId),
    dataShape: "value",
    staleTimeMs: COMPACTION_EPISODES_POLL_MS,
    queryFn,
    enabled,
    refetchInterval: COMPACTION_EPISODES_POLL_MS,
  });

  return { data: query.data, isLoading: enabled && query.isPending, isSupported };
}

/**
 * Cursors fetched so far for the current filter, reset back to a single first page whenever
 * `filterKey` changes. Resetting derived state on a key change during render is React's
 * documented pattern, the same one `use-jev-savings-events.ts` uses.
 */
function useFilteredCursors(filterKey: string): {
  cursors: (string | null)[];
  appendCursor: (cursor: string | null) => void;
} {
  const [state, setState] = useState<{ filterKey: string; cursors: (string | null)[] }>(() => ({
    filterKey,
    cursors: [null],
  }));
  if (state.filterKey !== filterKey) {
    setState({ filterKey, cursors: [null] });
  }
  const cursors = state.filterKey === filterKey ? state.cursors : [null];
  const appendCursor = useCallback(
    (cursor: string | null) =>
      setState((previous) => ({ filterKey, cursors: [...previous.cursors, cursor] })),
    [filterKey],
  );
  return { cursors, appendCursor };
}

interface PageResultLike {
  data?: CompactionEpisodesPage;
  isPending: boolean;
  error: Error | null;
}

function derivePagingState(cursors: (string | null)[], pageResults: PageResultLike[]) {
  const lastResult = pageResults[pageResults.length - 1];
  const nextCursor = lastResult?.data?.nextCursor ?? null;
  return {
    nextCursor,
    hasMore: nextCursor !== null,
    isLoadingFirstPage: cursors.length === 1 && (pageResults[0]?.isPending ?? false),
    isLoadingMore: cursors.length > 1 && (lastResult?.isPending ?? false),
    error: lastResult?.error ?? null,
  };
}

async function fetchEpisodesPage(
  client: DaemonClient | null,
  query: { range: CompactionRange; agentId?: string },
  cursor: string | null,
): Promise<CompactionEpisodesPage> {
  if (!client) throw new Error("compaction episodes requested without a host client");
  const payload = await client.compactionEpisodesList({ ...query, cursor: cursor ?? undefined });
  return { episodes: payload.episodes, nextCursor: payload.nextCursor };
}

export interface CompactionEpisodesListState {
  episodes: CompactionEpisode[];
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  loadMore: () => void;
  error: Error | null;
  isSupported: boolean;
}

/**
 * `compaction.episodes.list`, paged by cursor, filterable by agent, gated on
 * `server_info.features.compactionLedger`. Mirrors `useJevSavingsEvents`'s paging shape.
 */
export function useCompactionEpisodesList(
  serverId: string | null | undefined,
  query: { range: CompactionRange; agentId?: string },
  options: { enabled?: boolean } = {},
): CompactionEpisodesListState {
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const isSupported = useHostFeature(serverId, "compactionLedger");
  const enabled = Boolean(
    (options.enabled ?? true) && serverId && client && isConnected && isSupported,
  );

  const filterKey = compactionEpisodesListQueryKey(serverId, query).join("\u0000");
  const { cursors, appendCursor } = useFilteredCursors(filterKey);

  const pageResults = useFetchQueries<CompactionEpisodesPage>(
    cursors.map((cursor) => ({
      queryKey: [...compactionEpisodesListQueryKey(serverId, query), cursor ?? "first"],
      dataShape: "value",
      staleTimeMs: COMPACTION_EPISODES_POLL_MS,
      enabled,
      queryFn: () => fetchEpisodesPage(client, query, cursor),
    })),
  );

  const episodes = useMemo(
    () => pageResults.flatMap((result) => result.data?.episodes ?? []),
    [pageResults],
  );
  const { nextCursor, hasMore, isLoadingFirstPage, isLoadingMore, error } = derivePagingState(
    cursors,
    pageResults,
  );

  const loadMore = useCallback(() => {
    if (!hasMore || isLoadingMore) return;
    appendCursor(nextCursor);
  }, [appendCursor, hasMore, isLoadingMore, nextCursor]);

  return {
    episodes,
    isLoading: enabled && isLoadingFirstPage,
    isLoadingMore,
    hasMore,
    loadMore,
    error,
    isSupported,
  };
}
