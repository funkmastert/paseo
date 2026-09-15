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

  it("flags the real monthly spend-limit message and attributes it to the five_hour window via the session-limit reset text", () => {
    const message =
      "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 3:10pm (America/Los_Angeles)";
    const now = new Date(2026, 8, 15, 10, 0, 0);
    const result = classify(message, now);
    expect(result.isLimit).toBe(true);
    expect(result.window).toBe(WINDOW_FIVE_HOUR);
    expect(result.resetsAt).toEqual(new Date(2026, 8, 15, 15, 10, 0));
  });

  it("flags weekly and session spend-limit wording", () => {
    expect(classify("You've hit your weekly spend limit").isLimit).toBe(true);
    expect(classify("You've hit your session spend limit").isLimit).toBe(true);
  });

  it("flags usage-limit wording", () => {
    expect(classify("You've hit your usage limit for this account").isLimit).toBe(true);
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

  it("parses a clock-time resetsAt relative to now (local time), rolling to the next day if already passed", () => {
    const now = new Date(2026, 8, 10, 10, 0, 0);
    const later = classify("You've hit your limit, resets 3pm", now);
    expect(later.resetsAt).toEqual(new Date(2026, 8, 10, 15, 0, 0));

    const passed = classify("You've hit your limit, resets 3am", now);
    expect(passed.resetsAt).toEqual(new Date(2026, 8, 11, 3, 0, 0));
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

  it("session scope wins even when a model family is also named", () => {
    const result = classify("You've hit your limit for this 5 hour session for opus");
    expect(result.window).toBe(WINDOW_FIVE_HOUR);
  });

  it("hints a model-scoped weekly window for 'weekly <family> limit reached' phrasing", () => {
    const result = classify("You've hit your limit — weekly opus limit reached");
    expect(result.window).toBe(weeklyModelWindow("opus"));
  });

  it("leaves window undefined when a model family is named without weekly or session context", () => {
    const result = classify("You've hit your limit for opus, resets at 3am");
    expect(result.window).toBeUndefined();
  });

  it("leaves window undefined when the text gives no attribution", () => {
    const result = classify("You've hit your limit");
    expect(result.isLimit).toBe(true);
    expect(result.window).toBeUndefined();
  });
});
