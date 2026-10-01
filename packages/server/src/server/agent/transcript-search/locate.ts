/**
 * Where an agent's own transcript lives on disk, per provider. Reuses the same path-building the
 * daemon already uses to decide whether an account can resume a session
 * (`ClaudeAgentClient.canResumeHandle`), so a found/not-found answer here means the same thing it
 * means there.
 */

import { homedir } from "node:os";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { resolveClaudeConfigDir } from "../providers/claude/models.js";
import { findClaudeSessionTranscript } from "../providers/claude/project-dir.js";

export type TranscriptLocateResult =
  | { status: "found"; path: string }
  | { status: "not_found" }
  /** This agent's provider has no known transcript location (not Claude or Codex). */
  | { status: "unsupported" };

export interface TranscriptLocateTarget {
  provider: string;
  cwd: string;
  sessionId: string | null;
}

/** Override the real lookup roots; tests point these at fixture directories. */
export interface TranscriptLocateOverrides {
  claudeConfigDir?: string;
  codexHome?: string;
}

export async function locateAgentTranscript(
  target: TranscriptLocateTarget,
  overrides?: TranscriptLocateOverrides,
): Promise<TranscriptLocateResult> {
  if (!target.sessionId) return { status: "not_found" };
  switch (target.provider) {
    case "claude": {
      const configDir = overrides?.claudeConfigDir ?? resolveClaudeConfigDir(undefined);
      const path = findClaudeSessionTranscript({
        cwd: target.cwd,
        sessionId: target.sessionId,
        configDir,
      });
      return path ? { status: "found", path } : { status: "not_found" };
    }
    case "codex": {
      const codexHome = overrides?.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
      const path = await findCodexRolloutFile({ codexHome, sessionId: target.sessionId });
      return path ? { status: "found", path } : { status: "not_found" };
    }
    default:
      return { status: "unsupported" };
  }
}

// Codex has no path-builder in this codebase (its sessions are driven over the app-server
// protocol, not read from disk by paseo). Its own CLI lays rollouts out as
// `$CODEX_HOME/sessions/{YYYY}/{MM}/{DD}/rollout-{timestamp}-{session-id}.jsonl`
// (docs/development.md "Provider session files"); the timestamp is unknown here, so this walks
// the date partitions, newest first, looking for a filename ending in the session id.
async function findCodexRolloutFile(input: {
  codexHome: string;
  sessionId: string;
}): Promise<string | null> {
  const sessionsRoot = join(input.codexHome, "sessions");
  const suffix = `-${input.sessionId}.jsonl`;
  for (const year of (await safeReaddir(sessionsRoot)).sort().toReversed()) {
    const yearDir = join(sessionsRoot, year);
    for (const month of (await safeReaddir(yearDir)).sort().toReversed()) {
      const monthDir = join(yearDir, month);
      for (const day of (await safeReaddir(monthDir)).sort().toReversed()) {
        const found = await findRolloutInDay(join(monthDir, day), suffix);
        if (found) return found;
      }
    }
  }
  return null;
}

async function findRolloutInDay(dayDir: string, suffix: string): Promise<string | null> {
  for (const file of await safeReaddir(dayDir)) {
    if (file.startsWith("rollout-") && file.endsWith(suffix)) {
      return join(dayDir, file);
    }
  }
  return null;
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}
