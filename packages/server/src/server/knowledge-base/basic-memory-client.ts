import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import { z } from "zod";

import {
  BasicMemoryUnavailableError,
  type BasicMemorySidecarStatus,
  type BasicMemoryToolRequest,
} from "./basic-memory-sidecar.js";

/**
 * Searches the knowledge base through Basic Memory's `search_notes` tool (docs/knowledge-base.md).
 * Every Basic Memory result shape the daemon reads is mapped here, so a Basic Memory release
 * that changes it breaks this file and its test, not its callers.
 */

/** A search never waits on the knowledge-base lock, and gives up after this long. */
export const BASIC_MEMORY_SEARCH_TIMEOUT_MS = 10_000;

/**
 * Dedupe rule 3 (the plan's "Dedupe on kb_create") searches by embedding similarity only, with
 * this as the floor. Hybrid scores are relative: the top full-text hit always lands near 1.2 of
 * 1.3, related or not, so no hybrid floor separates the two. Cosine similarity from
 * bge-small-en-v1.5 does. In the 0.23.2 smoke run (title plus summary as the query, project
 * notes only) unrelated projects topped out at 0.673, and a same-initiative project for another
 * platform scored 0.76 to 0.85.
 */
export const BASIC_MEMORY_DEDUPE_SEARCH_TYPE = "vector";
export const BASIC_MEMORY_DEDUPE_MIN_SCORE = 0.7;

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const SNIPPET_MAX_CHARS = 300;

/** Omit for Basic Memory's default: hybrid while semantic search is on, otherwise text. */
export type BasicMemorySearchType = "hybrid" | "text" | "vector";

export interface BasicMemorySearchInput {
  query: string;
  limit?: number;
  searchType?: BasicMemorySearchType;
  /** Frontmatter `type` values, such as `project`. */
  noteTypes?: string[];
  /** Vector and hybrid only: drops results below this similarity. */
  minSimilarity?: number;
}

/**
 * One matching note. `score` is on the scale of the search type that produced it (hybrid 0 to
 * 1.3, vector 0 to 1, text a negated BM25 where lower is better); compare scores only within one
 * search type. `permalink` is null for a note whose frontmatter has none.
 */
export interface BasicMemorySearchResult {
  permalink: string | null;
  filePath: string;
  title: string;
  score: number;
  snippet: string;
  noteType: string | null;
}

export type BasicMemorySearchErrorCode = "search_unavailable" | "search_timeout" | "search_failed";

export class BasicMemorySearchError extends Error {
  constructor(
    readonly code: BasicMemorySearchErrorCode,
    message: string,
    /** Set for `search_unavailable`: what the sidecar is doing instead of running. */
    readonly sidecarStatus?: BasicMemorySidecarStatus,
  ) {
    super(message);
    this.name = "BasicMemorySearchError";
  }
}

/** The sidecar's call surface; a seam so the client can be driven without a process. */
export interface BasicMemoryToolCaller {
  callTool(request: BasicMemoryToolRequest, options: { timeoutMs: number }): Promise<unknown>;
}

const SearchRowSchema = z.object({
  title: z.string(),
  score: z.number(),
  file_path: z.string(),
  permalink: z.string().nullish(),
  matched_chunk: z.string().nullish(),
  content: z.string().nullish(),
  metadata: z.object({ note_type: z.string().nullish() }).nullish(),
});

const SearchResponseSchema = z.object({ results: z.array(SearchRowSchema) });

const ToolResultSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});

type SearchRow = z.infer<typeof SearchRowSchema>;

function toSnippet(row: SearchRow): string {
  const text = (row.matched_chunk ?? row.content ?? "").replace(/\s+/g, " ").trim();
  return text.length > SNIPPET_MAX_CHARS ? `${text.slice(0, SNIPPET_MAX_CHARS - 1)}…` : text;
}

function toResult(row: SearchRow): BasicMemorySearchResult {
  return {
    permalink: row.permalink ?? null,
    filePath: row.file_path,
    title: row.title,
    score: row.score,
    snippet: toSnippet(row),
    noteType: row.metadata?.note_type ?? null,
  };
}

function textOf(result: z.infer<typeof ToolResultSchema>): string {
  return (result.content ?? [])
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");
}

/**
 * The `output_format: "json"` payload. FastMCP may also return it as `structuredContent`,
 * wrapped under `result`; the text part always carries it.
 */
function readPayload(raw: unknown): unknown {
  const result = ToolResultSchema.safeParse(raw);
  if (!result.success) {
    throw new BasicMemorySearchError("search_failed", "Basic Memory returned an unexpected result");
  }
  if (result.data.isError) {
    throw new BasicMemorySearchError(
      "search_failed",
      textOf(result.data) || "Basic Memory search failed",
    );
  }
  const structured = result.data.structuredContent;
  if (structured && typeof structured["result"] === "object" && structured["result"] !== null) {
    return structured["result"];
  }
  try {
    return JSON.parse(textOf(result.data));
  } catch {
    throw new BasicMemorySearchError(
      "search_failed",
      "Basic Memory returned a result that is not JSON",
    );
  }
}

export interface BasicMemoryClientOptions {
  sidecar: BasicMemoryToolCaller;
  timeoutMs?: number;
}

export class BasicMemoryClient {
  private readonly sidecar: BasicMemoryToolCaller;
  private readonly timeoutMs: number;

  constructor(options: BasicMemoryClientOptions) {
    this.sidecar = options.sidecar;
    this.timeoutMs = options.timeoutMs ?? BASIC_MEMORY_SEARCH_TIMEOUT_MS;
  }

  /** Throws `BasicMemorySearchError`; the sidecar stays up after a timeout or a failed search. */
  async search(input: BasicMemorySearchInput): Promise<BasicMemorySearchResult[]> {
    const args: Record<string, unknown> = {
      query: input.query,
      page_size: Math.min(Math.max(1, input.limit ?? DEFAULT_LIMIT), MAX_LIMIT),
      output_format: "json",
    };
    if (input.searchType) args["search_type"] = input.searchType;
    if (input.noteTypes && input.noteTypes.length > 0) args["note_types"] = input.noteTypes;
    if (input.minSimilarity !== undefined) args["min_similarity"] = input.minSimilarity;

    let raw: unknown;
    try {
      raw = await this.sidecar.callTool(
        { name: "search_notes", arguments: args },
        { timeoutMs: this.timeoutMs },
      );
    } catch (error) {
      throw toSearchError(error, this.timeoutMs);
    }
    return parseSearchResults(raw);
  }
}

/** Maps one `search_notes` tool result. Throws `BasicMemorySearchError` (`search_failed`). */
export function parseSearchResults(raw: unknown): BasicMemorySearchResult[] {
  const payload = SearchResponseSchema.safeParse(readPayload(raw));
  if (!payload.success) {
    throw new BasicMemorySearchError(
      "search_failed",
      "Basic Memory search results did not have the expected shape",
    );
  }
  return payload.data.results.map(toResult);
}

function toSearchError(error: unknown, timeoutMs: number): BasicMemorySearchError {
  if (error instanceof BasicMemoryUnavailableError) {
    return new BasicMemorySearchError("search_unavailable", error.message, error.status);
  }
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
    return new BasicMemorySearchError(
      "search_timeout",
      `Basic Memory search took longer than ${timeoutMs} ms`,
    );
  }
  return new BasicMemorySearchError("search_failed", getErrorMessage(error));
}
