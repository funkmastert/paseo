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
  | { status: "ready"; rows: ListResult["rows"]; nextCursor?: string; summary: SummaryResult; loadingMore: boolean };

/** Adapter hook for the Decisions section (R3-R5): owns the RPC round trips, the filters driving them, and pagination. */
export function useClassifierDecisions() {
  const list = useRpc(classifierDecisionsRpc.list);
  const summary = useRpc(classifierDecisionsRpc.summary);
  const [filters, setFilters] = useState<ClassifierDecisionsFilters>(DEFAULT_CLASSIFIER_DECISIONS_FILTERS);
  const [load, setLoad] = useState<ClassifierDecisionsLoadState>({ status: "loading" });
  const tokenRef = useRef(0);

  const apiFilters = {
    disagreementsOnly: filters.disagreementsOnly || undefined,
    role: filters.role || undefined,
    workKind: filters.workKind || undefined,
  };
  const role = apiFilters.role;
  const workKind = apiFilters.workKind;
  const disagreementsOnly = apiFilters.disagreementsOnly;

  const reload = useCallback(() => {
    const token = (tokenRef.current += 1);
    setLoad({ status: "loading" });
    Promise.all([list({ disagreementsOnly, role, workKind }), summary({ role, workKind })])
      .then(([listResult, summaryResult]) => {
        if (tokenRef.current !== token) return;
        setLoad({ status: "ready", rows: listResult.rows, nextCursor: listResult.nextCursor, summary: summaryResult, loadingMore: false });
      })
      .catch((error) => {
        if (tokenRef.current !== token) return;
        setLoad({ status: "error", error: error instanceof Error ? error.message : String(error) });
      });
  }, [list, summary, disagreementsOnly, role, workKind]);

  useEffect(() => {
    reload();
  }, [reload]);

  const loadMore = useCallback(() => {
    setLoad((current) => {
      if (current.status !== "ready" || !current.nextCursor || current.loadingMore) {
        return current;
      }
      const token = tokenRef.current;
      const cursor = current.nextCursor;
      void list({ disagreementsOnly, role, workKind, cursor }).then((more) => {
        if (tokenRef.current !== token) return;
        setLoad((latest) =>
          latest.status === "ready"
            ? { ...latest, rows: [...latest.rows, ...more.rows], nextCursor: more.nextCursor, loadingMore: false }
            : latest,
        );
      });
      return { ...current, loadingMore: true };
    });
  }, [list, disagreementsOnly, role, workKind]);

  return { filters, setFilters, load, reload, loadMore };
}
