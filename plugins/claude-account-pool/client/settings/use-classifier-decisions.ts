import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { classifierDecisionsRpc } from "../../shared/classifier-decisions-rpc";
import type { RpcOutput } from "@getpaseo/plugin";

export interface ClassifierDecisionsFilters {
  disagreementsOnly: boolean;
  /** Empty string means "All" — the UI's own sentinel, never sent to the RPC. */
  role: string;
  workKind: string;
}

export const DEFAULT_CLASSIFIER_DECISIONS_FILTERS: ClassifierDecisionsFilters = {
  disagreementsOnly: false,
  role: "",
  workKind: "",
};

type ListResult = RpcOutput<typeof classifierDecisionsRpc.list>;
type SummaryResult = RpcOutput<typeof classifierDecisionsRpc.summary>;

export type ClassifierDecisionsLoadState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | {
      status: "ready";
      rows: ListResult["rows"];
      nextCursor?: string;
      summary: SummaryResult;
      loadingMore: boolean;
      loadMoreError?: string;
    };

/** Adapter hook for the Decisions section (R3-R5): owns the RPC round trips, the filters driving them, and pagination. */
export function useClassifierDecisions() {
  const list = useRpc(classifierDecisionsRpc.list);
  const summary = useRpc(classifierDecisionsRpc.summary);
  // The settings host rebuilds its plugin-surface runtime (and so `list`/`summary`) on every
  // render, so reading them through refs — rather than as `reload`/`loadMore` dependencies — keeps
  // those callbacks' identity (and the effect below) stable across a host re-render that has
  // nothing to do with this hook's own filters.
  const listRef = useRef(list);
  listRef.current = list;
  const summaryRef = useRef(summary);
  summaryRef.current = summary;

  const [filters, setFilters] = useState<ClassifierDecisionsFilters>(DEFAULT_CLASSIFIER_DECISIONS_FILTERS);
  const [load, setLoad] = useState<ClassifierDecisionsLoadState>({ status: "loading" });
  const loadRef = useRef(load);
  loadRef.current = load;
  const tokenRef = useRef(0);

  const role = filters.role || undefined;
  const workKind = filters.workKind || undefined;
  const disagreementsOnly = filters.disagreementsOnly || undefined;

  const reload = useCallback(() => {
    const token = (tokenRef.current += 1);
    setLoad({ status: "loading" });
    Promise.all([listRef.current({ disagreementsOnly, role, workKind }), summaryRef.current({ role, workKind })])
      .then(([listResult, summaryResult]) => {
        if (tokenRef.current !== token) return;
        setLoad({ status: "ready", rows: listResult.rows, nextCursor: listResult.nextCursor, summary: summaryResult, loadingMore: false });
      })
      .catch((error) => {
        if (tokenRef.current !== token) return;
        setLoad({ status: "error", error: error instanceof Error ? error.message : String(error) });
      });
  }, [disagreementsOnly, role, workKind]);

  useEffect(() => {
    reload();
  }, [reload]);

  const loadMore = useCallback(() => {
    const current = loadRef.current;
    if (current.status !== "ready" || !current.nextCursor || current.loadingMore) {
      return;
    }
    const token = tokenRef.current;
    const cursor = current.nextCursor;
    setLoad({ ...current, loadingMore: true, loadMoreError: undefined });
    // Issued outside any setState updater: a functional update can run twice under React
    // StrictMode, which would have fired this request twice and appended the page twice.
    listRef
      .current({ disagreementsOnly, role, workKind, cursor })
      .then((more) => {
        if (tokenRef.current !== token) return;
        setLoad((latest) =>
          latest.status === "ready"
            ? { ...latest, rows: [...latest.rows, ...more.rows], nextCursor: more.nextCursor, loadingMore: false }
            : latest,
        );
      })
      .catch((error) => {
        if (tokenRef.current !== token) return;
        setLoad((latest) =>
          latest.status === "ready"
            ? { ...latest, loadingMore: false, loadMoreError: error instanceof Error ? error.message : String(error) }
            : latest,
        );
      });
  }, [disagreementsOnly, role, workKind]);

  return { filters, setFilters, load, reload, loadMore };
}
