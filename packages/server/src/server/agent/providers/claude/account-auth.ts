import { readFileSync } from "node:fs";
import path from "node:path";

import type { AgentAccountAuth } from "../../agent-sdk-types.js";

const GLOBAL_CONFIG_FILENAME = ".claude.json";

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
    return { state: "signed-out", signInCommand: `CLAUDE_CONFIG_DIR=${configDir} claude /login` };
  }
  const email = (account as Record<string, unknown>).emailAddress;
  return { state: "signed-in", accountLabel: typeof email === "string" ? email : null };
}
