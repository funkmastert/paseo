import { describe, expect, it } from "vitest";
import { classify } from "./classify";
import { WINDOW_FIVE_HOUR, WINDOW_SEVEN_DAY, weeklyModelWindow } from "./windows";

describe("classify", () => {
  it("flags limit-shaped failure text as a limit", () => {
    expect(classify("You've hit your limit for this session").isLimit).toBe(true);
    expect(classify("You are being rate limited, try again later").isLimit).toBe(true);
    expect(classify("Insufficient quota remaining").isLimit).toBe(true);
    expect(classify("Out of credits").isLimit).toBe(true);
  });

  it("does not flag unrelated failure text as a limit", () => {
    expect(classify("Network timeout, please retry").isLimit).toBe(false);
    expect(classify("Invalid API key").isLimit).toBe(false);
    expect(classify("Internal server error").isLimit).toBe(false);
  });

  it("parses an ISO resetsAt timestamp from the message", () => {
    const result = classify("You've hit your limit, resets at 2026-09-10T15:00:00Z");
    expect(result.isLimit).toBe(true);
    expect(result.resetsAt?.toISOString()).toBe("2026-09-10T15:00:00.000Z");
  });

  it("parses a clock-time resetsAt relative to now, rolling to the next day if already passed", () => {
    const now = new Date("2026-09-10T10:00:00Z");
    const later = classify("You've hit your limit, resets 3pm", now);
    expect(later.resetsAt).toEqual(new Date("2026-09-10T15:00:00Z"));

    const passed = classify("You've hit your limit, resets 3am", now);
    expect(passed.resetsAt).toEqual(new Date("2026-09-11T03:00:00Z"));
  });

  it("hints the five_hour window for session-scoped language", () => {
    const result = classify("You've hit your limit for this 5-hour session");
    expect(result.window).toBe(WINDOW_FIVE_HOUR);
  });

  it("hints the seven_day window for weekly-scoped language", () => {
    const result = classify("You've hit your weekly quota");
    expect(result.window).toBe(WINDOW_SEVEN_DAY);
  });

  it("hints a model-scoped weekly window when a model family is named", () => {
    const result = classify("You've hit your limit — weekly Opus cap reached");
    expect(result.window).toBe(weeklyModelWindow("opus"));
  });

  it("leaves window undefined when the text gives no attribution", () => {
    const result = classify("You've hit your limit");
    expect(result.isLimit).toBe(true);
    expect(result.window).toBeUndefined();
  });
});
