import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { claudeSignInCommand, readClaudeAccountAuth } from "./account-auth.js";

const dirs: string[] = [];

function configDir(contents?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "paseo-claude-auth-"));
  dirs.push(dir);
  if (contents !== undefined) {
    writeFileSync(join(dir, ".claude.json"), JSON.stringify(contents));
  }
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("readClaudeAccountAuth", () => {
  test("reads the signed-in account's email from oauthAccount", () => {
    const dir = configDir({
      userID: "abc",
      oauthAccount: { emailAddress: "worker@example.com", accountUuid: "u" },
    });

    expect(readClaudeAccountAuth(dir)).toEqual({
      state: "signed-in",
      accountLabel: "worker@example.com",
      accountUuid: "u",
    });
  });

  test("a used config dir with no oauthAccount is signed out, with the command that fixes it", () => {
    // The shape `claude /logout` leaves behind: the file stays, the account key goes.
    const dir = configDir({ userID: "abc", hasAvailableSubscription: false });

    expect(readClaudeAccountAuth(dir)).toEqual({
      state: "signed-out",
      signInCommand: claudeSignInCommand(dir, null),
    });
  });

  test("says signed-in without a label when the account carries no email", () => {
    expect(readClaudeAccountAuth(configDir({ oauthAccount: { accountUuid: "u" } }))).toEqual({
      state: "signed-in",
      accountLabel: null,
      accountUuid: "u",
    });
  });

  test.each([
    ["a config dir the CLI has never written", undefined],
    ["a config file that is not an object", "nope"],
  ])("answers unknown for %s rather than guessing signed out", (_label, contents) => {
    const dir = contents === undefined ? configDir() : configDir(contents);

    expect(readClaudeAccountAuth(dir)).toEqual({ state: "unknown" });
  });

  test("answers unknown for unparseable JSON", () => {
    const dir = configDir({});
    writeFileSync(join(dir, ".claude.json"), "{ not json");

    expect(readClaudeAccountAuth(dir)).toEqual({ state: "unknown" });
  });
});

describe("claudeSignInCommand", () => {
  test("pre-fills the expected email so the browser does not default to another account", () => {
    expect(claudeSignInCommand("/home/u/.claude-personal", "worker@example.com", "linux")).toBe(
      "CLAUDE_CONFIG_DIR=/home/u/.claude-personal claude auth login --email worker@example.com",
    );
  });

  test("falls back to the bare command when no email is known", () => {
    expect(claudeSignInCommand("/home/u/.claude-personal", null, "linux")).toBe(
      "CLAUDE_CONFIG_DIR=/home/u/.claude-personal claude /login",
    );
  });

  test("leaves the config dir out when none resolves", () => {
    expect(claudeSignInCommand(null, "worker@example.com", "linux")).toBe(
      "claude auth login --email worker@example.com",
    );
    expect(claudeSignInCommand(null, null, "linux")).toBe("claude /login");
  });

  test("quotes an email that is not a plain shell word", () => {
    expect(claudeSignInCommand("/c", "o'brien@example.com", "linux")).toBe(
      "CLAUDE_CONFIG_DIR=/c claude auth login --email 'o'\\''brien@example.com'",
    );
  });

  test("quotes a config dir with a space, so the POSIX command still runs", () => {
    expect(
      claudeSignInCommand("/Users/some one/.claude-work", "worker@example.com", "darwin"),
    ).toBe(
      "CLAUDE_CONFIG_DIR='/Users/some one/.claude-work' claude auth login --email worker@example.com",
    );
  });

  test("leaves a plain home-relative dir unquoted", () => {
    expect(claudeSignInCommand("~/.claude_work-2", null, "linux")).toBe(
      "CLAUDE_CONFIG_DIR=~/.claude_work-2 claude /login",
    );
  });

  test("prints a PowerShell command on Windows, where VAR=value does not run", () => {
    expect(
      claudeSignInCommand("C:\\Users\\some one\\.claude-work", "worker@example.com", "win32"),
    ).toBe(
      "$env:CLAUDE_CONFIG_DIR='C:\\Users\\some one\\.claude-work'; claude auth login --email 'worker@example.com'",
    );
  });

  test("doubles single quotes in the Windows form", () => {
    expect(claudeSignInCommand("C:\\o'dir", "o'brien@example.com", "win32")).toBe(
      "$env:CLAUDE_CONFIG_DIR='C:\\o''dir'; claude auth login --email 'o''brien@example.com'",
    );
  });

  test("on Windows without an email or a dir, falls back the same way", () => {
    expect(claudeSignInCommand("C:\\c", null, "win32")).toBe(
      "$env:CLAUDE_CONFIG_DIR='C:\\c'; claude /login",
    );
    expect(claudeSignInCommand(null, "worker@example.com", "win32")).toBe(
      "claude auth login --email 'worker@example.com'",
    );
  });
});
