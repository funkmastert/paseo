import { useEffect, useMemo, useRef, useState } from "react";
import { subscribeToRelativeTimeTick } from "@/utils/relative-time-ticker";
import type { OrchestrationFlatRow } from "./orchestration-panel-model";
import {
  selectVisibleOrchestrationRows,
  type VisibleOrchestrationRows,
} from "./orchestration-visibility";

function sameRows(
  left: readonly OrchestrationFlatRow[],
  right: readonly OrchestrationFlatRow[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((row, index) => row === right[index]);
}

/**
 * The rows the panel renders, and the count it is holding back.
 *
 * The cutoff is a moving one, so it cannot be evaluated once per row change: a fleet that goes
 * quiet sends no agent update, the memo never re-runs, and the list stays exactly as it was when
 * the last agent stopped — the same freezing problem `useTokenBurnTones` documents. It re-runs on
 * the shared half-hourly tick as well, which is precise enough against a six-hour window and does
 * not wake a list every minute. A tick that changes nothing returns the previous array, so the
 * `FlatList` does not re-render.
 */
export function useOrchestrationVisibleRows(
  rows: readonly OrchestrationFlatRow[],
  input: { showOlder: boolean; alwaysKeepAgentId?: string | null },
): VisibleOrchestrationRows {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const lastReturnedRef = useRef<OrchestrationFlatRow[]>([]);
  const { showOlder, alwaysKeepAgentId } = input;

  const visible = useMemo(() => {
    if (showOlder) return { rows: [...rows], hiddenCount: 0 };
    return selectVisibleOrchestrationRows(rows, { nowMs, alwaysKeepAgentId });
  }, [alwaysKeepAgentId, nowMs, rows, showOlder]);

  const stableRows = sameRows(visible.rows, lastReturnedRef.current)
    ? lastReturnedRef.current
    : visible.rows;

  useEffect(() => {
    lastReturnedRef.current = stableRows;
  }, [stableRows]);

  useEffect(() => {
    if (showOlder) return undefined;
    return subscribeToRelativeTimeTick("hour", () => setNowMs(Date.now()));
  }, [showOlder]);

  return { rows: stableRows, hiddenCount: visible.hiddenCount };
}
