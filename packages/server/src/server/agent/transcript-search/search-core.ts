/**
 * The search engine, independent of the daemon: given a list of targets (already resolved from
 * whatever agent/tree the caller wants) and a query, locates each target's transcript file, greps
 * it, and reports coverage honestly. A partial search that claims "not found" is worse than none
 * (see packages/server/src/server/agent-history-search.ts), so every target gets one of exactly
 * five coverage answers: `searched`, `not_found`, `unsupported`, `truncated`, `timed_out`.
 */

import {
  detectBackend,
  searchWithNode,
  searchWithNodeRegexWorker,
  searchWithRipgrep,
  type BackendChoice,
  type FileSearchResult,
} from "./backend.js";
import { extractExcerptText } from "./excerpt.js";
import { locateAgentTranscript, type TranscriptLocateOverrides } from "./locate.js";

export type AgentCoverage = "searched" | "not_found" | "unsupported" | "truncated" | "timed_out";

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

export type SearchBackendLabel = BackendChoice["label"];

export interface TranscriptSearchResult {
  backend: SearchBackendLabel;
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
    const outcome = await searchFile(backend, located.path, compiled, query.maxMatchesPerAgent);
    if (outcome.kind === "timed_out") {
      agents.push({ ...base, coverage: "timed_out", matchCount: 0, excerpts: [] });
      continue;
    }
    if (outcome.kind === "error") {
      // The file was found a moment ago but became unreadable (race, permissions) or the search
      // itself failed unexpectedly; this agent's transcript cannot be answered for right now.
      agents.push({ ...base, coverage: "not_found", matchCount: 0, excerpts: [] });
      continue;
    }

    const { matches, truncated: fileTruncated } = outcome;
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

  return { backend: backend.label, agents };
}

type FileSearchOutcome =
  | ({ kind: "ok" } & FileSearchResult)
  | { kind: "timed_out" }
  | { kind: "error" };

async function searchFile(
  backend: BackendChoice,
  filePath: string,
  query: { pattern: string; regex: boolean; caseInsensitive: boolean },
  maxMatches: number,
): Promise<FileSearchOutcome> {
  if (backend.label !== "node") {
    try {
      const result = await searchWithRipgrep(filePath, query, maxMatches, backend.invocation);
      return { kind: "ok", ...result };
    } catch {
      // The binary was there at the detection probe but failed on this file (permissions, a
      // transient spawn error). Fall back rather than losing the agent's coverage entirely.
    }
  }
  return await searchOnNode(filePath, query, maxMatches);
}

/** Literal search stays on the main thread (linear). Regex runs in a worker with a deadline. */
async function searchOnNode(
  filePath: string,
  query: { pattern: string; regex: boolean; caseInsensitive: boolean },
  maxMatches: number,
): Promise<FileSearchOutcome> {
  if (!query.regex) {
    const result = await searchWithNode(filePath, query, maxMatches);
    return { kind: "ok", ...result };
  }
  const outcome = await searchWithNodeRegexWorker(filePath, query, maxMatches);
  if (outcome.status === "timed_out") return { kind: "timed_out" };
  if (outcome.status === "error") return { kind: "error" };
  return { kind: "ok", matches: outcome.matches, truncated: outcome.truncated };
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
