import { describe, expect, it } from "vitest";
import type { NotifyPolicySettings } from "@getpaseo/protocol/notify-policy/types";

import {
  availabilityForMode,
  digestIntervalChoice,
  durationChoiceForAvailability,
  interruptChoice,
  noticesChoice,
  noticesPatch,
} from "./host-notifications-state";

const defaults: NotifyPolicySettings = {
  minPostLevel: "notice",
  minInterruptLevel: "alert",
  digestIntervalMinutes: 30,
  availability: { mode: "available", until: null },
};
const NOW = Date.parse("2026-09-23T12:00:00.000Z");

describe("host notifications state", () => {
  it("reads the dials in the settings row's words", () => {
    expect(interruptChoice(defaults)).toBe("alert");
    expect(interruptChoice({ ...defaults, minInterruptLevel: "urgent" })).toBe("urgent");
    expect(interruptChoice({ ...defaults, minInterruptLevel: "notice" })).toBe("notice");
    expect(noticesChoice(defaults)).toBe("digest");
    expect(noticesChoice({ ...defaults, minPostLevel: "alert" })).toBe("off");
  });

  it("turning notices off raises the post dial above them and on lowers it back", () => {
    expect(noticesPatch("off")).toEqual({ minPostLevel: "alert" });
    expect(noticesPatch("digest")).toEqual({ minPostLevel: "notice" });
  });

  it("snaps a digest interval to the nearest choice at or above it", () => {
    expect(digestIntervalChoice({ ...defaults, digestIntervalMinutes: 10 })).toBe("15");
    expect(digestIntervalChoice({ ...defaults, digestIntervalMinutes: 45 })).toBe("60");
    expect(digestIntervalChoice({ ...defaults, digestIntervalMinutes: 500 })).toBe("180");
  });

  it("gives a timed mode an end and available none", () => {
    expect(availabilityForMode("focus", "oneHour", NOW)).toEqual({
      mode: "focus",
      until: "2026-09-23T13:00:00.000Z",
    });
    expect(availabilityForMode("away", "untilChanged", NOW)).toEqual({ mode: "away", until: null });
    expect(availabilityForMode("available", "fourHours", NOW)).toEqual({
      mode: "available",
      until: null,
    });
  });

  it("recovers the duration segment from an end time already set", () => {
    expect(durationChoiceForAvailability({ mode: "focus", until: null }, NOW)).toBe("untilChanged");
    expect(
      durationChoiceForAvailability({ mode: "focus", until: "2026-09-23T12:50:00.000Z" }, NOW),
    ).toBe("oneHour");
    expect(
      durationChoiceForAvailability({ mode: "focus", until: "2026-09-23T15:30:00.000Z" }, NOW),
    ).toBe("fourHours");
  });
});
