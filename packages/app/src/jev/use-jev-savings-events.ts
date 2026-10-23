import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useCallback, useMemo, useState } from "react";
import type {
  JevSavingsEvent,
  JevSavingsEventsPage,
  JevSavingsRange,
} from "@/jev/jev-savings-types";
import { useFetchQueries } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export interface JevSavingsEventsState {
  events: JevSavingsEvent[];
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  loadMore: () => void;
  error: Error | null;
}

export function jevSavingsEventsQueryKey(
  serverId: string | null | undefined,
  query: { range: JevSavingsRange; feature?: string; agentId?: string },
) {
  return [
    "jevSavingsEvents",
    serverId ?? "",
    query.range,
    query.feature ?? "",
    query.agentId ?? "",
  ] as const;
}

interface CursorState {
  filterKey: string;
  cursors: (string | null)[];
}

/**
 * Cursors fetched so far for the current filter, reset back to a single first page whenever
 * `filterKey` changes. Resetting derived state on a key change during render is React's
 * documented pattern: https://react.dev/learn/you-might-not-need-an-effect#resetting-all-state-when-a-prop-changes
 */
function useFilteredCursors(filterKey: string): {
  cursors: (string | null)[];
  appendCursor: (cursor: string | null) => void;
} {
  const [state, setState] = useState<CursorState>(() => ({ filterKey, cursors: [null] }));
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
  data?: JevSavingsEventsPage;
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

async function fetchEventsPage(
  client: DaemonClient | null,
  query: { range: JevSavingsRange; feature?: string; agentId?: string },
  cursor: string | null,
): Promise<JevSavingsEventsPage> {
  if (!client) throw new Error("JEV savings events requested without a host client");
  const payload = await client.jevSavingsEvents({ ...query, cursor: cursor ?? undefined });
  return { events: payload.events, nextCursor: payload.nextCursor };
}

/**
 * `jev.savings.events`, paged by cursor, filterable by feature and agent, gated on
 * `server_info.features.jevSavings`.
 *
 * Each fetched cursor is its own cached query (`useFetchQueries`, not `useInfiniteQuery`, which
 * app code may not call directly — `no-restricted-imports`). "Load more" appends the previous
 * page's `nextCursor` to the list; a filter change resets it back to a single first page.
 */
export function useJevSavingsEvents(
  serverId: string | null | undefined,
  query: { range: JevSavingsRange; feature?: string; agentId?: string },
  options: { enabled?: boolean } = {},
): JevSavingsEventsState {
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const isSupported = useHostFeature(serverId, "jevSavings");
  const enabled = Boolean(
    (options.enabled ?? true) && serverId && client && isConnected && isSupported,
  );

  const filterKey = jevSavingsEventsQueryKey(serverId, query).join("\u0000");
  const { cursors, appendCursor } = useFilteredCursors(filterKey);

  const pageResults = useFetchQueries<JevSavingsEventsPage>(
    cursors.map((cursor) => ({
      queryKey: [...jevSavingsEventsQueryKey(serverId, query), cursor ?? "first"],
      dataShape: "value",
      staleTimeMs: 30_000,
      enabled,
      queryFn: () => fetchEventsPage(client, query, cursor),
    })),
  );

  const events = useMemo(
    () => pageResults.flatMap((result) => result.data?.events ?? []),
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
    events,
    isLoading: enabled && isLoadingFirstPage,
    isLoadingMore,
    hasMore,
    loadMore,
    error,
  };
}
