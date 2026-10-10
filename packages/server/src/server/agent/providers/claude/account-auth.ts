import { readFileSync } from "node:fs";
import path from "node:path";

import type { AgentAccountAuth } from "../../agent-sdk-types.js";

const GLOBAL_CONFIG_FILENAME = ".claude.json";

/**
 * The command a person runs to sign the account behind `configDir` in. With an expected email the
 * OAuth page is pre-filled with it (`login_hint`), so a browser that is signed into a different
 * account does not win by default. Without one this is the bare command, and that is the only
 * fallback: a label is free text, so nothing is parsed out of it.
 */
export function claudeSignInCommand(configDir: string, expectedEmail?: string | null): string {
  const login = expectedEmail
    ? `claude auth login --email ${shellWord(expectedEmail)}`
    : "claude /login";
  return `CLAUDE_CONFIG_DIR=${configDir} ${login}`;
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9._%+@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Whether the account behind one `CLAUDE_CONFIG_DIR` is signed in. The CLI writes `oauthAccount`
 * into that directory's `.claude.json` on login and drops it on logout, so this is a file read of
 * a file the gateway already opens rather than a `claude auth status` subprocess.
 *
 * Deliberately asymmetric. The token itself lives in the OS keychain, so `oauthAccount` being
 * present does not prove the session still works — callers must not treat `signed-in` as a
 * guarantee. Its absence from a config file that exists does mean this directory has no account,
 * and that is the only answer anything acts on. A missing or unreadable file is `unknown`: a
 * config dir the CLI has never written says nothing about credentials.
 */
export function readClaudeAccountAuth(configDir: string): AgentAccountAuth {
  const configPath = path.join(configDir, GLOBAL_CONFIG_FILENAME);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return { state: "unknown" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { state: "unknown" };
  }
  const account = (parsed as Record<string, unknown>).oauthAccount;
  if (typeof account !== "object" || account === null) {
    return { state: "signed-out", signInCommand: claudeSignInCommand(configDir) };
  }
  const record = account as Record<string, unknown>;
  const email = record.emailAddress;
  const uuid = record.accountUuid;
  return {
    state: "signed-in",
    accountLabel: typeof email === "string" ? email : null,
    accountUuid: typeof uuid === "string" ? uuid : null,
  };
}
