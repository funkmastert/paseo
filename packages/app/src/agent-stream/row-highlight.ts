export const HIGHLIGHT_DURATION_MS = 1200;

export interface RowHighlightSource {
  subscribe: (listener: () => void) => () => void;
  getState: () => string | null;
}

export interface RowHighlightPublisher extends RowHighlightSource {
  /** Highlights `itemId`, auto-clearing after `HIGHLIGHT_DURATION_MS`. A second
   * call before the first clears cancels the pending clear and restarts it --
   * only one row is ever highlighted at a time. */
  highlight: (itemId: string) => void;
}

type TimeoutHandle = ReturnType<typeof setTimeout>;

interface CreateRowHighlightPublisherInput {
  setTimeout?: (callback: () => void, ms: number) => TimeoutHandle;
  clearTimeout?: (handle: TimeoutHandle) => void;
}

export function createRowHighlightPublisher(
  input: CreateRowHighlightPublisherInput = {},
): RowHighlightPublisher {
  const scheduleTimeout = input.setTimeout ?? setTimeout;
  const cancelTimeout = input.clearTimeout ?? clearTimeout;

  const listeners = new Set<() => void>();
  let highlightedId: string | null = null;
  let pendingClear: TimeoutHandle | null = null;

  function notify(): void {
    for (const listener of listeners) listener();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState: () => highlightedId,
    highlight(itemId) {
      if (pendingClear !== null) {
        cancelTimeout(pendingClear);
        pendingClear = null;
      }
      highlightedId = itemId;
      notify();
      pendingClear = scheduleTimeout(() => {
        pendingClear = null;
        highlightedId = null;
        notify();
      }, HIGHLIGHT_DURATION_MS);
    },
  };
}
