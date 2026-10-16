import { describe, expect, it, vi } from "vitest";
import { createRowHighlightPublisher, HIGHLIGHT_DURATION_MS } from "./row-highlight";

describe("createRowHighlightPublisher", () => {
  it("starts with no row highlighted", () => {
    const publisher = createRowHighlightPublisher();
    expect(publisher.getState()).toBeNull();
  });

  it("highlights the given id, then clears it after the highlight duration", () => {
    vi.useFakeTimers();
    try {
      const publisher = createRowHighlightPublisher();
      publisher.highlight("row-1");
      expect(publisher.getState()).toBe("row-1");

      vi.advanceTimersByTime(HIGHLIGHT_DURATION_MS - 1);
      expect(publisher.getState()).toBe("row-1");

      vi.advanceTimersByTime(1);
      expect(publisher.getState()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts the clear timer when a second row is highlighted before the first clears", () => {
    vi.useFakeTimers();
    try {
      const publisher = createRowHighlightPublisher();
      publisher.highlight("row-1");
      vi.advanceTimersByTime(HIGHLIGHT_DURATION_MS - 1);

      publisher.highlight("row-2");
      expect(publisher.getState()).toBe("row-2");

      // The first row's clear would have fired here had it not been cancelled.
      vi.advanceTimersByTime(1);
      expect(publisher.getState()).toBe("row-2");

      vi.advanceTimersByTime(HIGHLIGHT_DURATION_MS - 1);
      expect(publisher.getState()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("notifies subscribers on highlight and on clear, and stops after unsubscribe", () => {
    vi.useFakeTimers();
    try {
      const publisher = createRowHighlightPublisher();
      const listener = vi.fn();
      const unsubscribe = publisher.subscribe(listener);

      publisher.highlight("row-1");
      expect(listener).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(HIGHLIGHT_DURATION_MS);
      expect(listener).toHaveBeenCalledTimes(2);

      unsubscribe();
      publisher.highlight("row-2");
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
