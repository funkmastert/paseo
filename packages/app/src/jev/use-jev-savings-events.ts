import { useCallback, useMemo, useState } from "react";
import { createFakeJevSavingsReader } from "@/jev/fake-jev-savings-reader";
import type {
  JevSavingsEvent,
  JevSavingsEventsPage,
  JevSavingsRange,
} from "@/jev/jev-savings-types";
import { useFetchQueries } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";

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

/**
 * `jev.savings.events`, paged by cursor, filterable by feature and agent. The savings track's seam
 * already landed a real `DaemonClient.jevSavingsEvents`, but its handler drops everything until
 * the ledger merges — so this reads a local fake until then (`fake-jev-savings-reader.ts`); swap
 * the `queryFn` for a client call at that point, same shape.
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
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const isSupported = useHostFeature(serverId, "jevSavings");
  const reader = useMemo(() => createFakeJevSavingsReader(), []);
  const enabled = Boolean((options.enabled ?? true) && serverId && isConnected && isSupported);

  const filterKey = jevSavingsEventsQueryKey(serverId, query).join("\u0000");
  const { cursors, appendCursor } = useFilteredCursors(filterKey);

  const pageResults = useFetchQueries<JevSavingsEventsPage>(
    cursors.map((cursor) => ({
      queryKey: [...jevSavingsEventsQueryKey(serverId, query), cursor ?? "first"],
      dataShape: "value",
      staleTimeMs: 30_000,
      enabled,
      queryFn: () =>
        reader.events({
          range: query.range,
          feature: query.feature,
          agentId: query.agentId,
          cursor: cursor ?? undefined,
        }),
    })),
  );

  const events = useMemo(
    () => pageResults.flatMap((result) => result.data?.events ?? []),
    [pageResults],
  );
  const lastResult = pageResults[pageResults.length - 1];
  const nextCursor = lastResult?.data?.nextCursor ?? null;
  const hasMore = nextCursor !== null;
  const isLoadingFirstPage = cursors.length === 1 && (pageResults[0]?.isPending ?? false);
  const isLoadingMore = cursors.length > 1 && (lastResult?.isPending ?? false);

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
    error: lastResult?.error ?? null,
  };
}
