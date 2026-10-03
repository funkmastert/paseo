import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readClaudeAccountAuth } from "./account-auth.js";

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
    });
  });

  test("a used config dir with no oauthAccount is signed out, with the command that fixes it", () => {
    // The shape `claude /logout` leaves behind: the file stays, the account key goes.
    const dir = configDir({ userID: "abc", hasAvailableSubscription: false });

    expect(readClaudeAccountAuth(dir)).toEqual({
      state: "signed-out",
      signInCommand: `CLAUDE_CONFIG_DIR=${dir} claude /login`,
    });
  });

  test("says signed-in without a label when the account carries no email", () => {
    expect(readClaudeAccountAuth(configDir({ oauthAccount: { accountUuid: "u" } }))).toEqual({
      state: "signed-in",
      accountLabel: null,
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
