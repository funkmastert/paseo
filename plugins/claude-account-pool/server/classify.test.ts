import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classify, LIMIT_PATTERN } from "./classify";
import { WINDOW_ACCOUNT, WINDOW_FIVE_HOUR, WINDOW_SEVEN_DAY, weeklyModelWindow } from "./windows";

/**
 * Every per-window cap message the Claude CLI can print, from its one template
 * (`You've hit your ${name}${suffix}`) and its window-name map, read with `strings` from
 * `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`:
 *   five_hour → "session limit", seven_day → "weekly limit", seven_day_opus → "Opus limit",
 *   seven_day_sonnet → "Sonnet limit", seven_day_overage_included → "Fable 5 limit",
 *   overage → "usage credit limit".
 * The suffix is " · resets <when>" and sometimes " · progress saved". <when> is a clock time
 * within a day and a date past one, from `toLocaleString("en-US", {month: "short", day: "numeric",
 * hour: "numeric"})` under Bun's ICU: "Sep 25 at 11pm", as the live daemon log shows. Node's ICU
 * spells the same options "Sep 25, 11pm", and a year is added when it isn't this one.
 */
const CLI_CAP_MESSAGES: ReadonlyArray<{ message: string; window: string }> = [
  { message: "You've hit your session limit · resets 2:50pm (America/Los_Angeles)", window: WINDOW_FIVE_HOUR },
  { message: "You've hit your weekly limit · resets Oct 2 at 9am (America/Los_Angeles)", window: WINDOW_SEVEN_DAY },
  { message: "You've hit your Opus limit · resets Oct 2 at 9am · progress saved", window: weeklyModelWindow("opus") },
  { message: "You've hit your Sonnet limit · resets Oct 2 at 9am", window: weeklyModelWindow("sonnet") },
  { message: "You've hit your Fable 5 limit · resets Oct 2 at 9am", window: weeklyModelWindow("fable") },
  { message: "You've hit your usage credit limit · resets Oct 1 at 12am", window: WINDOW_ACCOUNT },
];

/**
 * The daemon's own detector, read out of its source. The plugin compiles on its own and cannot
 * import daemon code, so it carries a copy of the pattern; this is what keeps the copy honest.
 */
function daemonLimitPattern(): RegExp {
  const source = readFileSync(
    new URL("../../../packages/server/src/server/agent/account-failover-detector.ts", import.meta.url),
    "utf8",
  );
  const match = /const LIMIT_TEXT_PATTERN =\s*\/(.+)\/([a-z]*);/.exec(source);
  if (!match) {
    throw new Error("LIMIT_TEXT_PATTERN not found in account-failover-detector.ts; update this test");
  }
  return new RegExp(match[1], match[2]);
}

describe("classify — the CLI's per-window cap messages", () => {
  it.each(CLI_CAP_MESSAGES)("recognises $message as a cap on $window", ({ message, window }) => {
    const result = classify(message, new Date(2026, 8, 28, 14, 25, 0));
    expect(result.isLimit).toBe(true);
    expect(result.isAuthFailure).toBeFalsy();
    expect(result.window).toBe(window);
  });

  it("reads the session cap's reset time", () => {
    const result = classify(CLI_CAP_MESSAGES[0].message, new Date(2026, 8, 28, 14, 25, 0));
    expect(result.resetsAt).toEqual(new Date(2026, 8, 28, 14, 50, 0));
  });

  it.each(CLI_CAP_MESSAGES)("marks $message as evidence for placement only", ({ message }) => {
    expect(classify(message).placementOnly).toBe(true);
  });

  it("keeps a cap read from text it recognised before the per-window messages refusal-grade", () => {
    for (const message of [
      "You've hit your monthly spend limit · raise it at claude.ai/settings/usage · your session limit resets 3:10pm (America/Los_Angeles)",
      "You've hit your individual usage limit",
      "You've hit your org's monthly usage limit · resets Oct 1 at 12am",
      "You've hit your limit",
      "You are being rate limited, try again later",
      "Insufficient quota remaining",
    ]) {
      expect(classify(message).isLimit, message).toBe(true);
      expect(classify(message).placementOnly, message).toBeFalsy();
    }
  });

  it("reads a weekly cap's reset date, in the local zone", () => {
    const now = new Date(2026, 8, 28, 14, 25, 0);
    expect(classify(CLI_CAP_MESSAGES[1].message, now).resetsAt).toEqual(new Date(2026, 9, 2, 9, 0, 0));
    expect(classify("You've hit your weekly limit · resets Sep 30 at 11:30pm", now).resetsAt).toEqual(
      new Date(2026, 8, 30, 23, 30, 0),
    );
    expect(classify(CLI_CAP_MESSAGES[5].message, now).resetsAt).toEqual(new Date(2026, 9, 1, 0, 0, 0));
    expect(classify("You've hit your Opus limit · resets Oct 2 at 12pm", now).resetsAt).toEqual(
      new Date(2026, 9, 2, 12, 0, 0),
    );
  });

  it("reads Node's spelling of the same date, and a year when the CLI adds one", () => {
    const now = new Date(2026, 11, 30, 10, 0, 0);
    expect(classify("You've hit your weekly limit · resets Dec 31, 9am", now).resetsAt).toEqual(
      new Date(2026, 11, 31, 9, 0, 0),
    );
    const nextYear = classify("You've hit your weekly limit · resets Jan 2, 2027 at 9am (America/Los_Angeles)", now);
    expect(nextYear.resetsAt).toEqual(new Date(2027, 0, 2, 9, 0, 0));
    expect(classify("You've hit your Sonnet limit · resets Jan 2, 2027, 9:15am", now).resetsAt).toEqual(
      new Date(2027, 0, 2, 9, 15, 0),
    );
  });

  it("never reads a model-scoped cap as the whole account", () => {
    for (const family of ["Opus", "Sonnet", "Fable 5"]) {
      const result = classify(`You've hit your ${family} limit · resets 9am`);
      expect(result.window).toMatch(/^weekly_model_/);
    }
  });

  it("uses the same limit pattern as the daemon's failover detector", () => {
    expect(LIMIT_PATTERN.source).toBe(daemonLimitPattern().source);
    expect(LIMIT_PATTERN.flags).toBe(daemonLimitPattern().flags);
  });
});

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
    expect(classify("Internal server error").isLimit).toBe(false);
  });

  // Exact strings verified with `strings` against the compiled
  // @anthropic-ai/claude-agent-sdk-darwin-arm64/claude binary — the real CLI
  // output for a logged-out/bad-credential account, not guessed text.
  it("flags auth/credential failure text as a limit, distinctly from a usage cap", () => {
    const notLoggedIn = classify("Not logged in · Please run /login");
    expect(notLoggedIn.isLimit).toBe(true);
    expect(notLoggedIn.isAuthFailure).toBe(true);
    expect(notLoggedIn.window).toBeUndefined();
    expect(notLoggedIn.resetsAt).toBeUndefined();

    expect(classify("Invalid API key · Fix external API key").isAuthFailure).toBe(true);
    expect(classify("Invalid auth token · Fix external auth token").isAuthFailure).toBe(true);
    expect(classify("OAuth login failed: invalid_grant").isAuthFailure).toBe(true);
    expect(classify("Cloud authentication failed").isAuthFailure).toBe(true);
  });

  it("does not flag ordinary limit-shaped text as an auth failure", () => {
    expect(classify("You've hit your limit").isAuthFailure).toBeFalsy();
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
