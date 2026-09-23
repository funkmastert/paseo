/** Narrowest a chat can get before its composer and tool rows stop being usable. */
export const PINNED_GRID_MIN_CELL_WIDTH = 420;
/** Shortest a cell can get before the transcript is only a couple of lines above the composer. */
export const PINNED_GRID_MIN_CELL_HEIGHT = 360;
export const PINNED_GRID_MAX_COLUMNS = 4;

export interface PinnedGridMetrics {
  columns: number;
  rows: number;
  /** Height of one cell. */
  cellHeight: number;
  /** True when the rows do not fit at the minimum cell height and the grid scrolls. */
  scrolls: boolean;
}

/**
 * Columns follow the width: as many minimum-width cells as fit, never more than the chats there
 * are, so two chats fill a wide window rather than leaving empty columns.
 */
export function resolvePinnedGridColumns(input: { width: number; count: number }): number {
  const fit = Math.floor(input.width / PINNED_GRID_MIN_CELL_WIDTH);
  return Math.max(1, Math.min(fit, PINNED_GRID_MAX_COLUMNS, Math.max(1, input.count)));
}

/**
 * Rows share the available height evenly. Past what fits at the minimum cell height the grid
 * keeps that height and scrolls, so nothing is dropped and no cell is squashed.
 */
export function resolvePinnedGridMetrics(input: {
  width: number;
  height: number;
  count: number;
}): PinnedGridMetrics {
  const columns = resolvePinnedGridColumns(input);
  const rows = Math.max(1, Math.ceil(input.count / columns));
  const evenHeight = Math.floor(input.height / rows);
  const scrolls = evenHeight < PINNED_GRID_MIN_CELL_HEIGHT;
  return {
    columns,
    rows,
    cellHeight: scrolls ? PINNED_GRID_MIN_CELL_HEIGHT : evenHeight,
    scrolls,
  };
}
