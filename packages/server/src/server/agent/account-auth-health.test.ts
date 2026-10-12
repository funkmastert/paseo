import { describe, expect, it } from "vitest";
import { isAccountDeadError, isAuthShapedError } from "./account-failover-detector.js";
import { AccountAuthTracker } from "./account-auth-health.js";

const T0 = Date.parse("2026-10-12T18:00:00Z");
const MIN = 60_000;

function account(
  overrides: Partial<Parameters<AccountAuthTracker["observe"]>[0]["accounts"][0]> = {},
) {
  return {
    providerId: "claude-personal",
    enabled: true,
    configDir: "/home/tyler/.claude-personal",
    expectedEmail: null,
    ...overrides,
  };
}

describe("isAuthShapedError", () => {
  it.each([
    "Failed to authenticate: OAuth session expired and could not be refreshed",
    "OAuth session expired",
    "OAuth token revoked",
    "Not logged in",
    "Session expired",
    "Your session has expired",
    "Please run /login",
    "Invalid API key",
  ])("marks %s as auth-shaped", (text) => {
    expect(isAuthShapedError(text)).toBe(true);
  });

  it("does not mark the transient refresh-lock message", () => {
    expect(
      isAuthShapedError(
        "OAuth access token could not be refreshed: another Claude Code process is holding the refresh lock",
      ),
    ).toBe(false);
  });

  it("does not mark a limit-shaped message", () => {
    expect(isAuthShapedError("You've hit your monthly spend limit")).toBe(false);
  });
});

describe("isAccountDeadError", () => {
  it("is true for either a limit-shaped or an auth-shaped error", () => {
    expect(isAccountDeadError("You've hit your weekly limit")).toBe(true);
    expect(isAccountDeadError("Not logged in")).toBe(true);
    expect(isAccountDeadError("some unrelated error")).toBe(false);
  });
});

describe("AccountAuthTracker", () => {
  it("marks signed_out on an auth-shaped turn failure and opens one episode", () => {
    const tracker = new AccountAuthTracker();
    const result = tracker.observe({
      accounts: [account()],
      turnFailures: [{ providerId: "claude-personal", error: "Not logged in", atMs: T0 }],
    });
    expect(result.opened.map((e) => e.providerId)).toEqual(["claude-personal"]);
    expect(result.closed).toEqual([]);
    expect(tracker.stateFor("claude-personal")?.state).toBe("signed_out");
  });

  it("does not mark when a later successful turn postdates an older failure", () => {
    const tracker = new AccountAuthTracker();
    const result = tracker.observe({
      accounts: [account()],
      turnFailures: [{ providerId: "claude-personal", error: "Not logged in", atMs: T0 }],
      turnSuccesses: [{ providerId: "claude-personal", atMs: T0 + MIN }],
    });
    expect(result.opened).toEqual([]);
    expect(tracker.stateFor("claude-personal")?.state).toBe("ok");
  });

  it("closes the episode on a successful usage read, then opens a new one on a second sign-out", () => {
    const tracker = new AccountAuthTracker();
    tracker.observe({
      accounts: [account()],
      turnFailures: [{ providerId: "claude-personal", error: "Not logged in", atMs: T0 }],
    });

    const recovered = tracker.observe({
      accounts: [account()],
      readings: [{ providerId: "claude-personal", reading: "ok", atMs: T0 + MIN }],
    });
    expect(recovered.closed.map((e) => e.providerId)).toEqual(["claude-personal"]);
    expect(tracker.stateFor("claude-personal")?.state).toBe("ok");

    const signedOutAgain = tracker.observe({
      accounts: [account()],
      turnFailures: [{ providerId: "claude-personal", error: "Not logged in", atMs: T0 + 2 * MIN }],
    });
    expect(signedOutAgain.opened.map((e) => e.providerId)).toEqual(["claude-personal"]);
  });

  it("gives suspect on a rejected_expired reading, stays suspect on an inconclusive probe, and signed_out on an auth-shaped probe", () => {
    const tracker = new AccountAuthTracker();
    tracker.observe({
      accounts: [account()],
      readings: [{ providerId: "claude-personal", reading: "rejected_expired", atMs: T0 }],
    });
    expect(tracker.stateFor("claude-personal")?.state).toBe("suspect");

    tracker.observe({
      accounts: [account()],
      probes: [{ providerId: "claude-personal", result: "inconclusive", atMs: T0 + MIN }],
    });
    expect(tracker.stateFor("claude-personal")?.state).toBe("suspect");

    const result = tracker.observe({
      accounts: [account()],
      probes: [{ providerId: "claude-personal", result: "auth_failure", atMs: T0 + 2 * MIN }],
    });
    expect(tracker.stateFor("claude-personal")?.state).toBe("signed_out");
    expect(result.opened.map((e) => e.providerId)).toEqual(["claude-personal"]);
  });

  it("produces no record for a disabled provider even with auth-shaped failures", () => {
    const tracker = new AccountAuthTracker();
    const result = tracker.observe({
      accounts: [account({ enabled: false })],
      turnFailures: [{ providerId: "claude-personal", error: "Not logged in", atMs: T0 }],
    });
    expect(result.opened).toEqual([]);
    expect(tracker.stateFor("claude-personal")).toBeNull();
  });

  it("builds fixCommand from the declared email, else the .claude.json email, else a bare login", () => {
    const tracker = new AccountAuthTracker();
    tracker.observe({
      accounts: [account({ expectedEmail: "tyler@example.com" })],
      turnFailures: [{ providerId: "claude-personal", error: "Not logged in", atMs: T0 }],
    });
    expect(tracker.stateFor("claude-personal")?.fixCommand).toContain("tyler@example.com");

    const trackerNoExpected = new AccountAuthTracker();
    trackerNoExpected.observe({
      accounts: [
        {
          providerId: "claude-backup",
          enabled: true,
          configDir: "/tmp/does-not-exist-account-auth-health-test",
          expectedEmail: null,
        },
      ],
      turnFailures: [{ providerId: "claude-backup", error: "Not logged in", atMs: T0 }],
    });
    // No .claude.json at that path, so no last-known email either: falls all the way back.
    expect(trackerNoExpected.stateFor("claude-backup")?.fixCommand).toContain("claude /login");
  });
});
