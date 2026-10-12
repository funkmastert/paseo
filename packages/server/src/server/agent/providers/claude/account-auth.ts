import { readFileSync } from "node:fs";
import path from "node:path";

import type { AgentAccountAuth } from "../../agent-sdk-types.js";

const GLOBAL_CONFIG_FILENAME = ".claude.json";

/**
 * The `claude` arguments that sign `email` in. The OAuth page is pre-filled with it
 * (`login_hint`), so a browser that is signed into a different account does not win by default.
 * The daemon spawns exactly these for an in-app sign-in, and `claudeSignInCommand` prints them.
 */
export function claudeSignInArgs(email: string): string[] {
  return ["auth", "login", "--email", email];
}

/**
 * The command a person runs to sign the account behind `configDir` in, in the shell `platform`
 * opens by default: PowerShell on Windows, where `VAR=value cmd` does not run, and a POSIX shell
 * elsewhere. Without an expected email this is the bare, terminal-only `claude /login`, and that
 * is the only fallback: a label is free text, so nothing is parsed out of it. A null `configDir`
 * leaves the command unscoped.
 */
export function claudeSignInCommand(
  configDir: string | null,
  expectedEmail?: string | null,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const login = expectedEmail
      ? ["claude", ...claudeSignInArgs(expectedEmail).map(powerShellArg)].join(" ")
      : "claude /login";
    return configDir ? `$env:CLAUDE_CONFIG_DIR=${powerShellString(configDir)}; ${login}` : login;
  }
  const login = expectedEmail
    ? ["claude", ...claudeSignInArgs(expectedEmail)].map(shellWord).join(" ")
    : "claude /login";
  return configDir ? `CLAUDE_CONFIG_DIR=${shellWord(configDir)} ${login}` : login;
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9._%+@/~-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A PowerShell single-quoted string: nothing inside expands, and a quote is written twice. */
function powerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** A bare word when PowerShell reads it as one; `@` is not, since it starts a splat or array. */
function powerShellArg(value: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(value) ? value : powerShellString(value);
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

/**
 * The email `oauthAccount` last named in this config dir's `.claude.json`, whether or not the
 * session behind it still authenticates. An OAuth session that expired leaves `oauthAccount` in
 * place, so a sign-in command built from this can pre-fill the right login instead of falling
 * back to the terminal-only `claude /login`.
 */
export function lastKnownClaudeEmail(configDir: string): string | null {
  const auth = readClaudeAccountAuth(configDir);
  return auth.state === "signed-in" ? auth.accountLabel : null;
}
