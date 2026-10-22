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

const PR_CREATE_COMMAND = /^\s*gh\s+pr\s+create\b/;
const TEA_PR_CREATE_COMMAND = /^\s*tea\s+(?:pulls?|pr)\s+create\b/;
const GH_API_PULLS_PATH = /\bgh\s+api\b[^\n]*\/pulls(?:\/|\?|\s|$)/;
const GH_API_POST_INDICATOR = /(-X\s*POST|--method[= ]POST|\s-[fF]\s|--raw-field\b|--input\b)/i;
const MCP_CREATE_PULL_REQUEST_TOOL = /create_pull_request$/i;
const PR_URL_PATTERN = /https?:\/\/[^\s"'<>]+\/[^\s"'<>/]+\/[^\s"'<>/]+\/(?:pull|pulls)\/\d+/;

function parsePullRequestUrl(url: string): DetectedPullRequest | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
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

function detectFromShell(command: string, output: string | undefined): DetectedPullRequest | null {
  if (!output) return null;
  if (PR_CREATE_COMMAND.test(command) || TEA_PR_CREATE_COMMAND.test(command)) {
    return findFirstPrUrl(output);
  }
  if (GH_API_PULLS_PATH.test(command) && GH_API_POST_INDICATOR.test(command)) {
    return detectFromJsonText(output);
  }
  return null;
}

function detectFromJsonValue(value: unknown): DetectedPullRequest | null {
  if (typeof value === "string") return detectFromJsonText(value) ?? findFirstPrUrl(value);
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  const htmlUrl = typeof obj.html_url === "string" ? obj.html_url : undefined;
  if (htmlUrl) return parsePullRequestUrl(htmlUrl);
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
  if (detail.type === "shell") return detectFromShell(detail.command, detail.output);
  if (detail.type === "unknown") return detectFromUnknownTool(name, detail);
  return null;
}
