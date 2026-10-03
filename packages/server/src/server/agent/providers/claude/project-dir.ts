import { existsSync, realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Verbatim port of the Claude Agent SDK's project-directory encoding so
// paseo computes the same `~/.claude/projects/<dir>` path the SDK does.
// The SDK ships only as a precompiled bundle; grep the JS source at
// node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs for `function Ar`,
// `function So`, `async function wn`, `function Dy`, `Ni=200`.

const PROJECT_DIR_LENGTH_CAP = 200;

export interface ClaudeProjectDirOptions {
  configDir?: string;
}

export async function claudeProjectDir(
  cwd: string,
  options?: ClaudeProjectDirOptions,
): Promise<string> {
  const canonical = await canonicalize(cwd);
  const projectsRoot = join(resolveConfigDir(options), "projects");
  return join(projectsRoot, encode(canonical));
}

export function claudeProjectDirSync(cwd: string, options?: ClaudeProjectDirOptions): string {
  const canonical = canonicalizeSync(cwd);
  const projectsRoot = join(resolveConfigDir(options), "projects");
  return join(projectsRoot, encode(canonical));
}

async function canonicalize(input: string): Promise<string> {
  try {
    return normalizeProjectPath(await realpath(input));
  } catch {
    return normalizeProjectPath(input);
  }
}

function canonicalizeSync(input: string): string {
  try {
    return normalizeProjectPath(realpathSync.native(input));
  } catch {
    return normalizeProjectPath(input);
  }
}

function normalizeProjectPath(input: string): string {
  return process.platform === "darwin" ? input.normalize("NFC") : input;
}

function encode(input: string): string {
  const replaced = input.replace(/[^a-zA-Z0-9]/g, "-");
  if (replaced.length <= PROJECT_DIR_LENGTH_CAP) {
    return replaced;
  }
  return `${replaced.slice(0, PROJECT_DIR_LENGTH_CAP)}-${hashSuffix(input)}`;
}

function hashSuffix(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function resolveConfigDir(options?: ClaudeProjectDirOptions): string {
  return options?.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

/**
 * The transcript file for one session under `configDir`, or null when that account cannot see it.
 * Each account slot has its own `projects/`; cross-account resume works only because the slots
 * symlink it to a shared directory, so "can this account read this session" is a file lookup.
 */
export function findClaudeSessionTranscript(input: {
  cwd: string;
  sessionId: string;
  configDir: string;
}): string | null {
  for (const candidate of cwdCandidates(input.cwd)) {
    const transcript = claudeSessionTranscriptPath(candidate, input.sessionId, input.configDir);
    if (existsSync(transcript)) {
      return transcript;
    }
  }
  return null;
}

/** Where the transcript would live, whether or not it exists. */
export function claudeSessionTranscriptPath(
  cwd: string,
  sessionId: string,
  configDir: string,
): string {
  return join(claudeProjectDirSync(cwd, { configDir }), `${sessionId}.jsonl`);
}

function cwdCandidates(cwd: string): string[] {
  try {
    const real = realpathSync(cwd);
    return real === cwd ? [cwd] : [cwd, real];
  } catch {
    // The directory is gone; the configured path is still worth a lookup.
    return [cwd];
  }
}
