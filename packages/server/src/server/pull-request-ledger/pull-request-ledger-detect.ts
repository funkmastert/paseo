import type { ToolCallDetail } from "../agent/agent-sdk-types.js";

/**
 * A PR-creation tool call, normalized to one identity shape regardless of which forge CLI or
 * MCP tool produced it. See docs/pull-request-ledger.md for the three detected shapes.
 */
export interface DetectedPullRequest {
  host: string;
  repoOwner: string;
  repoName: string;
  number: number;
  url: string;
  /** The facts-family tag the URL path shape implies (docs/forge-providers.md): GitHub uses
   * `/pull/N`, the Gitea family (Gitea/Forgejo/Codeberg) uses `/pulls/N`. */
  forge: "github" | "gitea";
}

// Matches a command at the start of the string or right after a shell command separator
// (`;`, `&` of `&&`, `|` of `||`, `(`, or a newline), allowing leading `VAR=value` env
// assignments and `env`/`sudo` wrappers (with their own flags, e.g. `env -i`, `sudo -u user`)
// in either order. A plain `.test()` scan finds this boundary anywhere in a chained command
// (`cd wt && gh pr create ...`) without needing to split the string ourselves.
const BOUNDARY_SRC =
  "(?:^|[;&|(\\n])\\s*" +
  "(?:(?:env|sudo)\\s+(?:-\\S+\\s+)*)*" +
  "(?:[A-Za-z_][A-Za-z0-9_]*=\\S+\\s+)*";
const PR_CREATE_COMMAND = new RegExp(`${BOUNDARY_SRC}gh\\s+pr\\s+create\\b`);
const TEA_PR_CREATE_COMMAND = new RegExp(`${BOUNDARY_SRC}tea\\s+(?:pulls?|pr)\\s+create\\b`);

// `sh -c '...'` / `bash -lc '...'` / `zsh -c "..."` wrappers hide the real command behind a
// quote that isn't a command-boundary character, so the patterns above need the inner command
// unwrapped first.
const SHELL_WRAPPER = /\b(?:sh|bash|zsh)\s+-(?:lc|c)\b\s*(['"])([\s\S]*)\1\s*$/;

function unwrapShellCommand(command: string): string {
  const match = command.match(SHELL_WRAPPER);
  return match ? match[2] : command;
}

// A REST POST to the pulls collection endpoint creates a PR; anything else (GET, a sub-path
// like `/pulls/42/comments` or `/pulls/42/reviews`, or an explicit non-POST method) does not.
// Covers GitHub's `gh api repos/o/r/pulls` and Gitea/Forgejo's `/api/v1/repos/o/r/pulls`
// (reachable via `tea api`, a raw `curl`, or any other REST client).
const PULLS_COLLECTION_PATH = /\b(?:api\/v1\/)?repos\/[^/\s'"]+\/[^/\s'"]+\/pulls(?:[?\s'"]|$)/;
const EXPLICIT_METHOD = /(?:-X\s*|--method[= ])(['"]?)([A-Za-z]+)\1/i;
const IMPLICIT_POST_BODY_FLAG =
  /(\s-[fF]\s|--raw-field\b|--input\b|-d\b|--data(?:-raw|-binary|-urlencode)?\b)/;

function isPullsCreatePostCommand(command: string): boolean {
  if (!PULLS_COLLECTION_PATH.test(command)) return false;
  const explicitMethod = command.match(EXPLICIT_METHOD);
  if (explicitMethod) return explicitMethod[2].toUpperCase() === "POST";
  return IMPLICIT_POST_BODY_FLAG.test(command);
}

const MCP_CREATE_PULL_REQUEST_TOOL = /create_pull_request$/i;
const PR_URL_PATTERN = /https?:\/\/[^\s"'<>]+\/[^\s"'<>/]+\/[^\s"'<>/]+\/(?:pull|pulls)\/\d+/;

/** Exported so the session layer can derive a PR's identity from a forge snapshot's bare URL
 * (the workspace checkout's own current PR, which detection never observes as a tool call). */
export function parsePullRequestUrl(url: string): DetectedPullRequest | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // A `#fragment` (e.g. `#issuecomment-123`) means the URL points at a comment or review on
  // the PR, not the PR itself -- never a creation.
  if (parsed.hash) return null;
  // GitHub: /owner/repo/pull/N. Gitea/Forgejo/Codeberg: /owner/repo/pulls/N.
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/(pull|pulls)\/(\d+)(?:\/|$)/);
  if (!match) return null;
  const [, repoOwner, repoName, pathSegment, numberText] = match;
  const number = Number.parseInt(numberText, 10);
  if (!repoOwner || !repoName || !Number.isFinite(number)) return null;
  const forge = pathSegment === "pull" ? "github" : "gitea";
  return { host: parsed.host, repoOwner, repoName, number, url, forge };
}

function findFirstPrUrl(text: string): DetectedPullRequest | null {
  const match = text.match(PR_URL_PATTERN);
  return match ? parsePullRequestUrl(match[0]) : null;
}

function detectFromShell(
  command: string,
  output: string | undefined,
  exitCode: number | null | undefined,
): DetectedPullRequest | null {
  if (!output) return null;
  // A non-zero exit means the command failed; don't let a stray PR URL in its error output
  // (e.g. "a pull request for X already exists: <url>") register as a creation.
  if (typeof exitCode === "number" && exitCode !== 0) return null;
  const normalized = unwrapShellCommand(command);
  if (PR_CREATE_COMMAND.test(normalized) || TEA_PR_CREATE_COMMAND.test(normalized)) {
    return findFirstPrUrl(output);
  }
  if (isPullsCreatePostCommand(normalized)) {
    return detectFromJsonText(output);
  }
  return null;
}

function detectFromJsonValue(value: unknown): DetectedPullRequest | null {
  if (typeof value === "string") return detectFromJsonText(value) ?? findFirstPrUrl(value);
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  const htmlUrl = typeof obj.html_url === "string" ? obj.html_url : undefined;
  // A real PR-creation response body carries `number` alongside `html_url`; a comment or
  // review response's `html_url` points at the PR with a `#fragment` (rejected above) but
  // some shapes omit the fragment, so require `number` too before trusting it.
  if (htmlUrl && typeof obj.number === "number") {
    const parsed = parsePullRequestUrl(htmlUrl);
    if (parsed) return parsed;
  }
  // Gitea/Forgejo MCP-style result shapes nest the PR under a few common keys.
  for (const key of ["pull_request", "pullRequest", "data"]) {
    const nested = obj[key];
    if (nested && typeof nested === "object") {
      const found = detectFromJsonValue(nested);
      if (found) return found;
    }
  }
  return null;
}

function detectFromJsonText(text: string): DetectedPullRequest | null {
  try {
    return detectFromJsonValue(JSON.parse(text));
  } catch {
    return null;
  }
}

function detectFromUnknownTool(
  name: string,
  detail: {
    input: unknown;
    output: unknown;
  },
): DetectedPullRequest | null {
  if (!MCP_CREATE_PULL_REQUEST_TOOL.test(name)) return null;
  return detectFromJsonValue(detail.output);
}

/**
 * Pure: a completed tool call's name and detail in, the PR it created (or `null`) out. A command
 * or result that doesn't parse is not every `gh`/`tea`/MCP call creating a PR — return `null`
 * rather than throwing.
 */
export function detectPullRequestCreation(
  name: string,
  detail: ToolCallDetail,
): DetectedPullRequest | null {
  if (detail.type === "shell")
    return detectFromShell(detail.command, detail.output, detail.exitCode);
  if (detail.type === "unknown") return detectFromUnknownTool(name, detail);
  return null;
}
