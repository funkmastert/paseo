import { describe, expect, it, vi } from "vitest";
import { jumpToTimelineStart } from "./timeline-start-navigation";

describe("jumpToTimelineStart", () => {
  it("skips the fetch when the earliest page is already loaded", async () => {
    const fetchStart = vi.fn(() => Promise.resolve());
    const revealEarliest = vi.fn(() => "item-1");
    const scrollToStart = vi.fn();

    await jumpToTimelineStart({
      needsFetch: false,
      fetchStart,
      revealEarliest,
      scrollToStart,
      onError: vi.fn(),
    });

    expect(fetchStart).not.toHaveBeenCalled();
    expect(scrollToStart).toHaveBeenCalledWith("item-1");
  });

  it("fetches the earliest page before revealing and scrolling to the revealed id", async () => {
    const order: string[] = [];
    const fetchStart = vi.fn(async () => {
      order.push("fetch");
    });
    const revealEarliest = vi.fn(() => {
      order.push("reveal");
      return "item-0";
    });
    const scrollToStart = vi.fn((itemId: string | null) => {
      order.push(`scroll:${itemId}`);
    });

    await jumpToTimelineStart({
      needsFetch: true,
      fetchStart,
      revealEarliest,
      scrollToStart,
      onError: vi.fn(),
    });

    expect(order).toEqual(["fetch", "reveal", "scroll:item-0"]);
  });

  it("scrolls with null when nothing was revealed", async () => {
    const scrollToStart = vi.fn();

    await jumpToTimelineStart({
      needsFetch: false,
      fetchStart: vi.fn(),
      revealEarliest: () => null,
      scrollToStart,
      onError: vi.fn(),
    });

    expect(scrollToStart).toHaveBeenCalledWith(null);
  });

  it("reports a failed fetch without revealing, scrolling, or rejecting", async () => {
    const revealEarliest = vi.fn();
    const scrollToStart = vi.fn();
    const onError = vi.fn();
    const logError = vi.fn();

    await expect(
      jumpToTimelineStart({
        needsFetch: true,
        fetchStart: () => Promise.reject(new Error("disconnected")),
        revealEarliest,
        scrollToStart,
        onError,
        logError,
      }).then(() => ({
        revealed: revealEarliest.mock.calls.length,
        scrolled: scrollToStart.mock.calls.length,
        errors: onError.mock.calls.length,
        warnings: logError.mock.calls.length,
      })),
    ).resolves.toEqual({ revealed: 0, scrolled: 0, errors: 1, warnings: 1 });
  });
});
