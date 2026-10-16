import { describe, expect, it } from "vitest";
import {
  PINNED_GRID_MAX_COLUMNS,
  PINNED_GRID_MIN_CELL_HEIGHT,
  resolvePinnedGridColumns,
  resolvePinnedGridMetrics,
} from "./pinned-grid-layout";

describe("resolvePinnedGridColumns", () => {
  it("adds columns as the window widens", () => {
    expect(resolvePinnedGridColumns({ width: 500, count: 8 })).toBe(1);
    expect(resolvePinnedGridColumns({ width: 900, count: 8 })).toBe(2);
    expect(resolvePinnedGridColumns({ width: 1300, count: 8 })).toBe(3);
  });

  it("never makes more columns than chats or than the cap", () => {
    expect(resolvePinnedGridColumns({ width: 2400, count: 2 })).toBe(2);
    expect(resolvePinnedGridColumns({ width: 4000, count: 20 })).toBe(PINNED_GRID_MAX_COLUMNS);
  });

  it("keeps one column when the width is below one minimum cell", () => {
    expect(resolvePinnedGridColumns({ width: 200, count: 3 })).toBe(1);
  });
});

describe("resolvePinnedGridMetrics", () => {
  it("splits the height evenly across rows when they fit", () => {
    expect(resolvePinnedGridMetrics({ width: 1300, height: 900, count: 4 })).toEqual({
      columns: 3,
      rows: 2,
      cellHeight: 450,
      scrolls: false,
    });
  });

  it("holds the minimum cell height and scrolls when many chats do not fit", () => {
    const metrics = resolvePinnedGridMetrics({ width: 1300, height: 800, count: 12 });
    expect(metrics.columns).toBe(3);
    expect(metrics.rows).toBe(4);
    expect(metrics.cellHeight).toBe(PINNED_GRID_MIN_CELL_HEIGHT);
    expect(metrics.scrolls).toBe(true);
  });
});
