export async function jumpToTimelineStart(input: {
  needsFetch: boolean;
  fetchStart: () => Promise<unknown>;
  // Returns the id of the earliest item it revealed, so scrollToStart can target
  // it directly rather than re-deriving "the earliest row" from a render that may
  // not have committed the reveal yet.
  revealEarliest: () => string | null;
  scrollToStart: (itemId: string | null) => void;
  onError: () => void;
  logError?: (message: string, error: unknown) => void;
}): Promise<void> {
  try {
    if (input.needsFetch) {
      await input.fetchStart();
    }
    const earliestItemId = input.revealEarliest();
    input.scrollToStart(earliestItemId);
  } catch (error) {
    (input.logError ?? console.warn)("Failed to jump to the start of the timeline", error);
    input.onError();
  }
}
