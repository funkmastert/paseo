/**
 * The search engine, independent of the daemon: given a list of targets (already resolved from
 * whatever agent/tree the caller wants) and a query, locates each target's transcript file, greps
 * it, and reports coverage honestly. A partial search that claims "not found" is worse than none
 * (see packages/server/src/server/agent-history-search.ts), so every target gets one of exactly
 * four coverage answers: `searched`, `not_found`, `unsupported`, `truncated`.
 */

import { detectBackend, searchWithNode, searchWithRipgrep } from "./backend.js";
import { extractExcerptText } from "./excerpt.js";
import { locateAgentTranscript, type TranscriptLocateOverrides } from "./locate.js";

export type AgentCoverage = "searched" | "not_found" | "unsupported" | "truncated";

export interface TranscriptExcerpt {
  lineNumber: number;
  role: string | null;
  text: string;
}

export interface TranscriptSearchTarget {
  agentId: string;
  title: string | null;
  provider: string;
  cwd: string;
  sessionId: string | null;
}

export interface TranscriptSearchQuery {
  pattern: string;
  regex: boolean;
  caseInsensitive: boolean;
  maxMatchesPerAgent: number;
  maxExcerptChars: number;
  maxTotalBytes: number;
}

export interface AgentSearchResult {
  agentId: string;
  title: string | null;
  provider: string;
  coverage: AgentCoverage;
  matchCount: number;
  excerpts: TranscriptExcerpt[];
}

export interface TranscriptSearchResult {
  backend: "ripgrep" | "node";
  agents: AgentSearchResult[];
}

export async function searchTranscripts(
  targets: TranscriptSearchTarget[],
  query: TranscriptSearchQuery,
  overrides?: TranscriptLocateOverrides,
): Promise<TranscriptSearchResult> {
  validateQuery(query);
  const backend = await detectBackend();
  const agents: AgentSearchResult[] = [];
  let totalBytes = 0;
  let budgetExhausted = false;

  for (const target of targets) {
    const base = { agentId: target.agentId, title: target.title, provider: target.provider };
    if (budgetExhausted) {
      agents.push({ ...base, coverage: "truncated", matchCount: 0, excerpts: [] });
      continue;
    }

    const located = await locateAgentTranscript(target, overrides);
    if (located.status !== "found") {
      agents.push({ ...base, coverage: located.status, matchCount: 0, excerpts: [] });
      continue;
    }

    const compiled = {
      pattern: query.pattern,
      regex: query.regex,
      caseInsensitive: query.caseInsensitive,
    };
    const { matches, truncated: fileTruncated } = await searchFile(
      backend,
      located.path,
      compiled,
      query.maxMatchesPerAgent,
    );

    const excerpts: TranscriptExcerpt[] = [];
    let byteCapped = false;
    for (const match of matches) {
      const extracted = extractExcerptText(match.line, query.maxExcerptChars);
      const text = extracted?.text ?? "(no readable text on this line)";
      const role = extracted?.role ?? null;
      const bytes = Buffer.byteLength(text, "utf8");
      if (totalBytes + bytes > query.maxTotalBytes) {
        byteCapped = true;
        budgetExhausted = true;
        break;
      }
      totalBytes += bytes;
      excerpts.push({ lineNumber: match.lineNumber, role, text });
    }

    agents.push({
      ...base,
      coverage: fileTruncated || byteCapped ? "truncated" : "searched",
      matchCount: excerpts.length,
      excerpts,
    });
  }

  return { backend, agents };
}

async function searchFile(
  backend: "ripgrep" | "node",
  filePath: string,
  query: { pattern: string; regex: boolean; caseInsensitive: boolean },
  maxMatches: number,
) {
  if (backend === "ripgrep") {
    try {
      return await searchWithRipgrep(filePath, query, maxMatches);
    } catch {
      // The binary was there at the detection probe but failed on this file (permissions, a
      // transient spawn error). Fall back rather than losing the agent's coverage entirely.
      return await searchWithNode(filePath, query, maxMatches);
    }
  }
  return await searchWithNode(filePath, query, maxMatches);
}

function validateQuery(query: TranscriptSearchQuery): void {
  if (!query.regex) return;
  try {
    // eslint-disable-next-line no-new -- validating that the pattern compiles, nothing else.
    new RegExp(query.pattern);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regular expression: ${message}`, { cause: error });
  }
}
