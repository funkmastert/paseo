import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUsagePoller } from "./usage-poll";
import { createHealthTracker } from "./health";
import { WINDOW_FIVE_HOUR } from "./windows";

const PROVIDER = "claude-worker-a";

describe("createUsagePoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps fetched usage rows into health tracker readings on each interval tick", async () => {
    const tracker = createHealthTracker({ now: () => new Date("2026-09-10T10:00:00Z") });
    const fetchUsage = vi.fn().mockResolvedValue({
      providers: [
        {
          providerId: PROVIDER,
          windows: [{ id: WINDOW_FIVE_HOUR, usedPct: 95, resetsAt: "2026-09-10T15:00:00Z" }],
        },
      ],
    });

    const poller = createUsagePoller(tracker, { fetchUsage, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(fetchUsage).toHaveBeenCalledTimes(1);
    expect(tracker.snapshot()[PROVIDER]?.[WINDOW_FIVE_HOUR]?.status).toBe("drained");
    poller.stop();
  });

  it("handles a payload missing a provider's row gracefully (no reading = no change)", async () => {
    const tracker = createHealthTracker({ now: () => new Date("2026-09-10T10:00:00Z") });
    tracker.reportTurnFailure(PROVIDER, "You've hit your limit");
    const fetchUsage = vi.fn().mockResolvedValue({ providers: [] });

    const poller = createUsagePoller(tracker, { fetchUsage, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(tracker.isHealthyFor(PROVIDER, "claude-sonnet-5")).toBe(false);
    poller.stop();
  });

  it("leaves tracker state untouched when the fetch rejects", async () => {
    const tracker = createHealthTracker({ now: () => new Date("2026-09-10T10:00:00Z") });
    tracker.reportUsage(PROVIDER, [{ window: WINDOW_FIVE_HOUR, usedPct: 10, resetsAt: null }]);
    const fetchUsage = vi.fn().mockRejectedValue(new Error("daemon unreachable"));

    const poller = createUsagePoller(tracker, { fetchUsage, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(tracker.snapshot()[PROVIDER]?.[WINDOW_FIVE_HOUR]?.status).toBe("healthy");
    poller.stop();
  });

  it("stop() clears the interval so no further polls happen", async () => {
    const tracker = createHealthTracker({ now: () => new Date("2026-09-10T10:00:00Z") });
    const fetchUsage = vi.fn().mockResolvedValue({ providers: [] });
    const poller = createUsagePoller(tracker, { fetchUsage, intervalMs: 1000 });

    poller.stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(fetchUsage).not.toHaveBeenCalled();
  });

  it("pollOnce() triggers an immediate fetch without waiting for the interval", async () => {
    const tracker = createHealthTracker({ now: () => new Date("2026-09-10T10:00:00Z") });
    const fetchUsage = vi.fn().mockResolvedValue({
      providers: [{ providerId: PROVIDER, windows: [{ id: WINDOW_FIVE_HOUR, usedPct: 10, resetsAt: null }] }],
    });
    const poller = createUsagePoller(tracker, { fetchUsage, intervalMs: 60_000 });

    await poller.pollOnce();

    expect(fetchUsage).toHaveBeenCalledTimes(1);
    expect(tracker.snapshot()[PROVIDER]?.[WINDOW_FIVE_HOUR]?.status).toBe("healthy");
    poller.stop();
  });
});
