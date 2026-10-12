import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    configDir: "/accounts/personal",
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
    const configDir = mkdtempSync(join(tmpdir(), "account-auth-health-"));
    try {
      writeFileSync(
        join(configDir, ".claude.json"),
        JSON.stringify({ oauthAccount: { emailAddress: "last@example.com" } }),
      );
      const tracker = new AccountAuthTracker();
      tracker.observe({
        accounts: [
          account({ providerId: "declared", configDir, expectedEmail: "someone@example.com" }),
          account({ providerId: "last-known", configDir }),
          account({ providerId: "unknown", configDir: "/tmp/does-not-exist-account-auth-health" }),
        ],
        turnFailures: ["declared", "last-known", "unknown"].map((providerId) => ({
          providerId,
          error: "Not logged in",
          atMs: T0,
        })),
      });
      expect(tracker.stateFor("declared")).toMatchObject({
        email: "someone@example.com",
        fixCommand: `CLAUDE_CONFIG_DIR=${configDir} claude auth login --email someone@example.com`,
      });
      expect(tracker.stateFor("last-known")).toMatchObject({ email: "last@example.com" });
      expect(tracker.stateFor("unknown")).toMatchObject({
        email: null,
        fixCommand: "CLAUDE_CONFIG_DIR=/tmp/does-not-exist-account-auth-health claude /login",
      });
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("quotes the email in the sign-in command, and leaves CLAUDE_CONFIG_DIR out when no dir resolves", () => {
    const tracker = new AccountAuthTracker();
    tracker.observe({
      accounts: [account({ configDir: null, expectedEmail: "first last@example.com" })],
      turnFailures: [{ providerId: "claude-personal", error: "Not logged in", atMs: T0 }],
    });
    expect(tracker.stateFor("claude-personal")).toMatchObject({
      fixCommand: "claude auth login --email 'first last@example.com'",
    });
  });

  it("reads no login for an account that is fine", () => {
    const configDir = mkdtempSync(join(tmpdir(), "account-auth-health-"));
    try {
      writeFileSync(
        join(configDir, ".claude.json"),
        JSON.stringify({ oauthAccount: { emailAddress: "someone@example.com" } }),
      );
      const tracker = new AccountAuthTracker();
      tracker.observe({
        accounts: [account({ configDir })],
        readings: [{ providerId: "claude-personal", reading: "ok", atMs: T0 }],
      });
      const record = tracker.stateFor("claude-personal");
      expect(record?.state).toBe("ok");
      expect(record).not.toHaveProperty("email");
      expect(record).not.toHaveProperty("fixCommand");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
