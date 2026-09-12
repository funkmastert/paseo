import { describe, expect, it, vi } from "vitest";
import { createLogThrottle } from "./log-throttle";

describe("createLogThrottle", () => {
  it("logs once per key per window even under a burst of identical calls", () => {
    let nowMs = 0;
    const log = vi.fn();
    const throttle = createLogThrottle({ windowMs: 60_000, now: () => nowMs });

    for (let i = 0; i < 10; i++) {
      throttle("same-key", log);
    }

    expect(log).toHaveBeenCalledTimes(1);
  });

  it("logs again once the window has elapsed", () => {
    let nowMs = 0;
    const log = vi.fn();
    const throttle = createLogThrottle({ windowMs: 60_000, now: () => nowMs });

    throttle("same-key", log);
    nowMs += 59_999;
    throttle("same-key", log);
    expect(log).toHaveBeenCalledTimes(1);

    nowMs += 1;
    throttle("same-key", log);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("throttles independently per key", () => {
    let nowMs = 0;
    const log = vi.fn();
    const throttle = createLogThrottle({ windowMs: 60_000, now: () => nowMs });

    throttle("key-a", log);
    throttle("key-b", log);

    expect(log).toHaveBeenCalledTimes(2);
  });
});
