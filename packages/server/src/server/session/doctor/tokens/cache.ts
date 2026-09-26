import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { DoctorContext } from "../context.js";
import { row, unknownRow, type TokenAuditCheck, type TokenAuditRow } from "./types.js";

export const CACHE_CHECK_TIMEOUT_MS = 240_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 7;
const SCAN_CONCURRENCY = 4;
const READ_CHUNK_BYTES = 1024 * 1024;
const LIFETIME_SAMPLE_FILES = 50;
/** A turn that writes more than this to the cache re-wrote a large part of the context. */
export const REBUILD_TURN_TOKENS = 50_000;
/** Context above this is re-read on every further turn. */
export const LARGE_CONTEXT_TOKENS = 200_000;
const REBUILD_SHARE_AMBER_PERCENT = 20;
const ONE_HOUR_MS = 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const WORST_SESSIONS_LISTED = 5;

/** One API response, after its per-content-block duplicate lines are collapsed. */
export interface Turn {
  timestamp: number;
  isSidechain: boolean;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** `usage.cache_creation.ephemeral_1h_input_tokens`. */
  oneHour: number;
  /** `usage.cache_creation.ephemeral_5m_input_tokens`. */
  fiveMin: number;
  /** Cache-creation tokens the transcript did not attribute to a lifetime. */
  unsplit: number;
}

export interface ParsedTurn {
  sessionId: string | null;
  cwd: string | null;
  messageId: string;
  turn: Turn;
}

export interface SessionTurns {
  sessionId: string;
  cwd: string | null;
  turns: Turn[];
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One JSONL line to a turn, or null when the line is not a real, billed assistant response.
 * `isSidechain` is the file-level default: every line under `subagents/` is a sidechain.
 */
export function parseAssistantLine(
  line: string,
  defaults: { isSidechain?: boolean } = {},
): ParsedTurn | null {
  // Cheap gate: most lines are user turns, tool results and attachments.
  if (!line.includes('"usage"') || !line.includes('"type":"assistant"')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed["type"] !== "assistant") return null;
  const message = parsed["message"];
  if (!isRecord(message)) return null;
  const messageId = message["id"];
  const usage = message["usage"];
  if (typeof messageId !== "string" || !isRecord(usage)) return null;
  if (message["model"] === "<synthetic>") return null;
  const timestamp = typeof parsed["timestamp"] === "string" ? Date.parse(parsed["timestamp"]) : NaN;
  if (!Number.isFinite(timestamp)) return null;

  const input = tokenCount(usage["input_tokens"]);
  const output = tokenCount(usage["output_tokens"]);
  const cacheRead = tokenCount(usage["cache_read_input_tokens"]);
  const cacheCreation = tokenCount(usage["cache_creation_input_tokens"]);
  if (input + output + cacheRead + cacheCreation === 0) return null;

  let oneHour = 0;
  let fiveMin = 0;
  const split = usage["cache_creation"];
  if (
    isRecord(split) &&
    (typeof split["ephemeral_1h_input_tokens"] === "number" ||
      typeof split["ephemeral_5m_input_tokens"] === "number")
  ) {
    oneHour = tokenCount(split["ephemeral_1h_input_tokens"]);
    fiveMin = tokenCount(split["ephemeral_5m_input_tokens"]);
  }
  const unsplit = Math.max(0, cacheCreation - oneHour - fiveMin);

  return {
    sessionId: typeof parsed["sessionId"] === "string" ? parsed["sessionId"] : null,
    cwd: typeof parsed["cwd"] === "string" ? parsed["cwd"] : null,
    messageId,
    turn: {
      timestamp,
      isSidechain: parsed["isSidechain"] === true || defaults.isSidechain === true,
      input,
      output,
      cacheRead,
      cacheCreation,
      oneHour,
      fiveMin,
      unsplit,
    },
  };
}

interface SessionAccumulator {
  cwd: string | null;
  turns: Map<string, Turn>;
}

/**
 * Collapses the repeated lines of one API response: within a session, one message id is one
 * turn, and the line with the most output tokens wins (a tie goes to the later line, which is
 * the final usage the API reported).
 */
export class TurnCollector {
  private readonly sessions = new Map<string, SessionAccumulator>();

  constructor(private readonly window: { since?: number; until?: number } = {}) {}

  /** Returns the session id the line belongs to, or null when the line was not a counted turn. */
  add(line: string, fallbackSessionId: string, isSidechainFile = false): string | null {
    const parsed = parseAssistantLine(line, { isSidechain: isSidechainFile });
    if (!parsed) return null;
    const { turn } = parsed;
    if (this.window.since !== undefined && turn.timestamp < this.window.since) return null;
    if (this.window.until !== undefined && turn.timestamp > this.window.until) return null;
    const sessionId = parsed.sessionId ?? fallbackSessionId;
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { cwd: null, turns: new Map() };
      this.sessions.set(sessionId, session);
    }
    session.cwd ??= parsed.cwd;
    const existing = session.turns.get(parsed.messageId);
    if (!existing || turn.output >= existing.output) session.turns.set(parsed.messageId, turn);
    return sessionId;
  }

  results(): SessionTurns[] {
    return [...this.sessions].map(([sessionId, s]) => ({
      sessionId,
      cwd: s.cwd,
      turns: [...s.turns.values()],
    }));
  }
}

export function aggregateTranscriptLines(
  lines: Iterable<string>,
  options: { fallbackSessionId?: string; since?: number; until?: number } = {},
): SessionTurns[] {
  const collector = new TurnCollector(options);
  for (const line of lines) collector.add(line, options.fallbackSessionId ?? "unknown");
  return collector.results();
}

export interface TurnSummary {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
  /** Percent of `total`, one decimal. */
  shares: { cacheRead: number; cacheCreation: number; input: number; output: number };
  /** Context of the first / last main-thread turn (sidechain turns when there are none). */
  firstContext: number | null;
  lastContext: number | null;
  rebuildTurns: number;
  rebuildTokens: number;
  oneHour: number;
  fiveMin: number;
  unsplit: number;
}

export function percent(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

export function turnContext(turn: Turn): number {
  return turn.input + turn.cacheRead + turn.cacheCreation;
}

interface Edge {
  first: Turn | null;
  last: Turn | null;
}

function trackEdge(edge: Edge, turn: Turn): void {
  if (!edge.first || turn.timestamp < edge.first.timestamp) edge.first = turn;
  if (!edge.last || turn.timestamp >= edge.last.timestamp) edge.last = turn;
}

export function summarizeTurns(turns: Iterable<Turn>): TurnSummary {
  const s = {
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    rebuildTurns: 0,
    rebuildTokens: 0,
    oneHour: 0,
    fiveMin: 0,
    unsplit: 0,
  };
  const main: Edge = { first: null, last: null };
  const side: Edge = { first: null, last: null };
  for (const turn of turns) {
    s.turns += 1;
    s.input += turn.input;
    s.output += turn.output;
    s.cacheRead += turn.cacheRead;
    s.cacheCreation += turn.cacheCreation;
    s.oneHour += turn.oneHour;
    s.fiveMin += turn.fiveMin;
    s.unsplit += turn.unsplit;
    if (turn.cacheCreation > REBUILD_TURN_TOKENS) {
      s.rebuildTurns += 1;
      s.rebuildTokens += turn.cacheCreation;
    }
    trackEdge(turn.isSidechain ? side : main, turn);
  }
  const edge = main.first ? main : side;
  const total = s.input + s.output + s.cacheRead + s.cacheCreation;
  return {
    ...s,
    total,
    shares: {
      cacheRead: percent(s.cacheRead, total),
      cacheCreation: percent(s.cacheCreation, total),
      input: percent(s.input, total),
      output: percent(s.output, total),
    },
    firstContext: edge.first ? turnContext(edge.first) : null,
    lastContext: edge.last ? turnContext(edge.last) : null,
  };
}

export type CacheLifetime = "1h" | "5m" | "mixed" | "UNKNOWN";

/** Which cache lifetime the writes used. `mixed` means both were written in the window. */
export function cacheLifetimeInUse(oneHourTokens: number, fiveMinTokens: number): CacheLifetime {
  if (oneHourTokens <= 0 && fiveMinTokens <= 0) return "UNKNOWN";
  if (fiveMinTokens <= 0) return "1h";
  if (oneHourTokens <= 0) return "5m";
  return "mixed";
}

function resolveWindowDays(ctx: DoctorContext): number {
  const agents = ctx.rawConfig?.["agents"];
  const audit = isRecord(agents) ? agents["tokenAudit"] : undefined;
  const days = isRecord(audit) ? audit["windowDays"] : undefined;
  return typeof days === "number" && Number.isFinite(days) && days > 0 ? days : DEFAULT_WINDOW_DAYS;
}

interface TranscriptFile {
  path: string;
  mtimeMs: number;
  /** Session id implied by the path, for lines that carry none. */
  pathSessionId: string;
  /** `<session>.jsonl` directly under a project dir, as opposed to `subagents/`. */
  topLevel: boolean;
  isSubagent: boolean;
}

function describeFile(root: string, file: string, mtimeMs: number): TranscriptFile {
  const parts = path.relative(root, file).split(path.sep);
  // <slug>/<session>.jsonl or <slug>/<session>/subagents/.../<agent>.jsonl
  const raw = parts[1] ?? parts[0] ?? file;
  return {
    path: file,
    mtimeMs,
    pathSessionId: raw.replace(/\.jsonl$/, ""),
    topLevel: parts.length === 2,
    isSubagent: parts.includes("subagents"),
  };
}

/**
 * Every `.jsonl` under `root` modified at or after `cutoff`, newest first. Each real directory
 * and file is visited once, however many symlinks lead to it.
 */
async function listTranscriptFiles(
  root: string,
  cutoff: number,
  now: () => number,
  deadline: number,
): Promise<{ files: TranscriptFile[]; complete: boolean }> {
  const files: TranscriptFile[] = [];
  const seenDirs = new Set<string>([root]);
  const seenFiles = new Set<string>();
  const pending = [root];
  let complete = true;
  while (pending.length > 0) {
    if (now() > deadline) {
      complete = false;
      break;
    }
    const dir = pending.pop() as string;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const candidates: Array<{ full: string; symlink: boolean }> = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!seenDirs.has(full)) {
          seenDirs.add(full);
          pending.push(full);
        }
      } else if (entry.isSymbolicLink()) {
        candidates.push({ full, symlink: true });
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        candidates.push({ full, symlink: false });
      }
    }
    await Promise.all(
      candidates.map(async ({ full: candidate, symlink }) => {
        try {
          // Only a symlink can lead to a file or directory already reached another way.
          const real = symlink ? await realpath(candidate) : candidate;
          const info = await stat(real);
          if (info.isDirectory()) {
            if (!seenDirs.has(real)) {
              seenDirs.add(real);
              pending.push(real);
            }
            return;
          }
          if (!real.endsWith(".jsonl") || info.mtimeMs < cutoff || seenFiles.has(real)) return;
          seenFiles.add(real);
          // Keep the path we walked so the session id still comes from the project layout.
          files.push(describeFile(root, candidate, info.mtimeMs));
        } catch {
          // A file that vanished mid-walk is not a file in the window.
        }
      }),
    );
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { files, complete };
}

async function readLines(
  file: string,
  onLine: (line: string) => void,
  shouldStop: () => boolean,
): Promise<boolean> {
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: READ_CHUNK_BYTES });
  let carry = "";
  try {
    for await (const chunk of stream) {
      const text = carry + (chunk as string);
      let start = 0;
      let newline = text.indexOf("\n", start);
      while (newline !== -1) {
        onLine(text.slice(start, newline));
        start = newline + 1;
        newline = text.indexOf("\n", start);
      }
      carry = text.slice(start);
      if (shouldStop()) return false;
    }
  } finally {
    stream.destroy();
  }
  if (carry) onLine(carry);
  return true;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface TranscriptScan {
  sessions: SessionTurns[];
  filesInWindow: number;
  filesRead: number;
  stoppedAtDeadline: boolean;
  /** The session of the newest top-level transcript that produced a turn. */
  newestSessionId: string | null;
}

export type TranscriptScanOutcome =
  | { ok: true; scan: TranscriptScan }
  | { ok: false; reason: string };

/**
 * Streams the shared Claude projects dir once. Accounts symlink `projects/` to one canonical
 * directory, so the real path is resolved first and everything under it is read once.
 */
export async function scanTranscripts(
  ctx: DoctorContext,
  deadline: number,
  options: { maxFiles?: number; concurrency?: number } = {},
): Promise<TranscriptScanOutcome> {
  const windowMs = resolveWindowDays(ctx) * DAY_MS;
  const now = ctx.now;
  const startedAt = now();
  const cutoff = startedAt - windowMs;
  const projectsDir = path.join(ctx.home, ".claude", "projects");
  let root: string;
  try {
    root = await realpath(projectsDir);
    await readdir(root);
  } catch (error) {
    return { ok: false, reason: `cannot read ${projectsDir}: ${(error as Error).message}` };
  }

  const listing = await listTranscriptFiles(root, cutoff, now, deadline);
  const files = options.maxFiles ? listing.files.slice(0, options.maxFiles) : listing.files;
  const collector = new TurnCollector({ since: cutoff });
  const fileSessions = new Map<string, string>();
  let filesRead = 0;
  let stoppedAtDeadline = !listing.complete;
  let next = 0;

  const worker = async () => {
    while (next < files.length) {
      if (now() > deadline) {
        stoppedAtDeadline = true;
        return;
      }
      const file = files[next++] as TranscriptFile;
      try {
        const completed = await readLines(
          file.path,
          (line) => {
            const sessionId = collector.add(line, file.pathSessionId, file.isSubagent);
            if (sessionId !== null && !fileSessions.has(file.path)) {
              fileSessions.set(file.path, sessionId);
            }
          },
          () => now() > deadline,
        );
        if (completed) filesRead += 1;
        else stoppedAtDeadline = true;
      } catch {
        // Unreadable file: it stays unread, so coverage says so.
      }
      await yieldToEventLoop();
    }
  };
  await Promise.all(
    Array.from({ length: options.concurrency ?? SCAN_CONCURRENCY }, () => worker()),
  );

  const newest = files.find((f) => f.topLevel && fileSessions.has(f.path));
  return {
    ok: true,
    scan: {
      sessions: collector.results(),
      filesInWindow: listing.files.length,
      filesRead,
      stoppedAtDeadline,
      newestSessionId: newest ? (fileSessions.get(newest.path) ?? null) : null,
    },
  };
}

export interface CacheLifetimeMeasurement {
  /**
   * 3_600_000 or 300_000: the lifetime most written tokens used (both were written when the split
   * says so); null only when nothing was written.
   */
  lifetimeMs: number | null;
  oneHourTokens: number;
  fiveMinTokens: number;
}

/** Which cache lifetime the newest transcripts wrote, for checks that compare intervals to it. */
export async function measureCacheLifetime(
  ctx: DoctorContext,
  deadline: number,
): Promise<CacheLifetimeMeasurement> {
  const outcome = await scanTranscripts(ctx, deadline, { maxFiles: LIFETIME_SAMPLE_FILES });
  if (!outcome.ok) return { lifetimeMs: null, oneHourTokens: 0, fiveMinTokens: 0 };
  let oneHourTokens = 0;
  let fiveMinTokens = 0;
  for (const session of outcome.scan.sessions) {
    for (const turn of session.turns) {
      oneHourTokens += turn.oneHour;
      fiveMinTokens += turn.fiveMin;
    }
  }
  const lifetime = cacheLifetimeInUse(oneHourTokens, fiveMinTokens);
  let lifetimeMs: number | null;
  if (lifetime === "UNKNOWN") {
    lifetimeMs = null;
  } else if (oneHourTokens >= fiveMinTokens) {
    lifetimeMs = ONE_HOUR_MS;
  } else {
    lifetimeMs = FIVE_MINUTES_MS;
  }
  return { lifetimeMs, oneHourTokens, fiveMinTokens };
}

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

function n(value: number): string {
  return NUMBER_FORMAT.format(value);
}

function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function describeCwd(cwd: string | null): string {
  return cwd ?? "cwd unknown";
}

function sharesText(s: TurnSummary): string {
  return `cache read ${s.shares.cacheRead}%, cache creation ${s.shares.cacheCreation}%, input ${s.shares.input}%, output ${s.shares.output}%`;
}

function lifetimeText(s: TurnSummary): string {
  const unsplit = s.unsplit > 0 ? `, unsplit ${n(s.unsplit)}` : "";
  return `cache writes by lifetime: 1h ${n(s.oneHour)}, 5m ${n(s.fiveMin)}${unsplit} (in use: ${cacheLifetimeInUse(s.oneHour, s.fiveMin)})`;
}

function contextText(value: number | null): string {
  return value === null ? "UNKNOWN" : `${n(value)} tokens`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

function lastTimestamp(session: SessionTurns): number {
  let latest = -Infinity;
  for (const turn of session.turns) latest = Math.max(latest, turn.timestamp);
  return latest;
}

function windowLabel(ctx: DoctorContext): string {
  return `${resolveWindowDays(ctx)}d`;
}

function newestSessionRow(session: SessionTurns): TokenAuditRow {
  const s = summarizeTurns(session.turns);
  const over = s.lastContext !== null && s.lastContext > LARGE_CONTEXT_TOKENS;
  return row(
    "cache",
    "cache:newest-session",
    over ? "AMBER" : "GREEN",
    `Newest session ${shortId(session.sessionId)} (${describeCwd(session.cwd)}): cache read ${s.shares.cacheRead}% of ${n(s.total)} tokens`,
    `${n(s.turns)} turns; ${sharesText(s)}; first-turn context ${contextText(s.firstContext)}, last-turn context ${contextText(s.lastContext)}; ${lifetimeText(s)}`,
    over
      ? `context above ${n(LARGE_CONTEXT_TOKENS)} is re-read every turn: ${n((s.lastContext as number) - LARGE_CONTEXT_TOKENS)} tokens over`
      : `${n(s.cacheCreation)} tokens written to cache, ${n(s.rebuildTokens)} of them in ${n(s.rebuildTurns)} rebuild turns (>${n(REBUILD_TURN_TOKENS)} written)`,
    {
      "cache.readShare": s.shares.cacheRead,
      "cache.creationShare": s.shares.cacheCreation,
      ...(s.lastContext === null ? {} : { "cache.lastTurnContext": s.lastContext }),
    },
  );
}

interface SessionEnd {
  session: SessionTurns;
  lastContext: number;
}

function fleetRows(ctx: DoctorContext, scan: TranscriptScan): TokenAuditRow[] {
  const ends: SessionEnd[] = [];
  function* allTurns(): Generator<Turn> {
    for (const session of scan.sessions) {
      const summary = summarizeTurns(session.turns);
      if (summary.lastContext !== null) ends.push({ session, lastContext: summary.lastContext });
      yield* session.turns;
    }
  }
  const fleet = summarizeTurns(allTurns());
  const over = ends
    .filter((e) => e.lastContext > LARGE_CONTEXT_TOKENS)
    .sort((a, b) => b.lastContext - a.lastContext);
  const sessionCount = scan.sessions.length;
  const overShare = percent(over.length, sessionCount);
  const rebuildShare = percent(fleet.rebuildTokens, fleet.cacheCreation);
  const lastContextMedian = median(ends.map((e) => e.lastContext));
  const amber = over.length > 0 || rebuildShare > REBUILD_SHARE_AMBER_PERCENT;
  const coverage = `read ${n(scan.filesRead)} of ${n(scan.filesInWindow)} files${scan.stoppedAtDeadline ? " (stopped at the deadline)" : ""}`;

  const rows: TokenAuditRow[] = [
    row(
      "cache",
      "cache:fleet-7d",
      amber ? "AMBER" : "GREEN",
      `Fleet, last ${windowLabel(ctx)}: cache read ${fleet.shares.cacheRead}% of ${n(fleet.total)} tokens across ${n(sessionCount)} sessions`,
      `${n(sessionCount)} sessions, ${n(fleet.turns)} turns; ${sharesText(fleet)}; ${n(over.length)} of ${n(sessionCount)} sessions (${overShare}%) ended above ${n(LARGE_CONTEXT_TOKENS)} tokens of context, median last-turn context ${n(lastContextMedian)}; ${n(fleet.rebuildTurns)} rebuild turns (>${n(REBUILD_TURN_TOKENS)} written) wrote ${n(fleet.rebuildTokens)} tokens, ${rebuildShare}% of all cache writes; ${lifetimeText(fleet)}; ${coverage}`,
      `${n(fleet.rebuildTokens)} tokens re-written by rebuild turns; context above ${n(LARGE_CONTEXT_TOKENS)} is re-read every turn in ${n(over.length)} sessions`,
      {
        "cache.readShare": fleet.shares.cacheRead,
        "cache.creationShare": fleet.shares.cacheCreation,
        "cache.inputShare": fleet.shares.input,
        "cache.outputShare": fleet.shares.output,
        "cache.lastTurnContextMedian": lastContextMedian,
        "cache.sessionsOver200k": over.length,
        "cache.rebuildTurns": fleet.rebuildTurns,
      },
    ),
  ];

  if (over.length > 0) {
    const worst = over.slice(0, WORST_SESSIONS_LISTED);
    const excess = over.reduce((sum, e) => sum + (e.lastContext - LARGE_CONTEXT_TOKENS), 0);
    rows.push(
      row(
        "cache",
        "cache:fleet-7d:over-200k",
        "AMBER",
        `${n(over.length)} sessions ended above ${n(LARGE_CONTEXT_TOKENS)} tokens of context`,
        worst
          .map(
            (e) =>
              `${shortId(e.session.sessionId)} (${path.basename(e.session.cwd ?? "") || "cwd unknown"}): ${n(e.lastContext)} tokens`,
          )
          .join("; ") +
          (over.length > worst.length ? `; ${n(over.length - worst.length)} more` : ""),
        `${n(excess)} tokens above ${n(LARGE_CONTEXT_TOKENS)} across these sessions are re-read every further turn`,
      ),
    );
  }
  return rows;
}

export const cacheCheck: TokenAuditCheck = {
  id: "tokens.cache",
  item: "cache",
  timeoutMs: CACHE_CHECK_TIMEOUT_MS,
  async measure(ctx, deadline) {
    const key = "cache:newest-session";
    const finding = "Cache usage";
    const outcome = await scanTranscripts(ctx, deadline);
    if (!outcome.ok) return [unknownRow("cache", key, finding, outcome.reason)];
    const { scan } = outcome;
    if (scan.filesInWindow === 0) {
      return [
        unknownRow(
          "cache",
          key,
          finding,
          `no transcript files under ${path.join(ctx.home, ".claude", "projects")} were modified in the last ${windowLabel(ctx)}`,
        ),
      ];
    }
    if (scan.sessions.length === 0) {
      return [
        unknownRow(
          "cache",
          key,
          finding,
          `read ${n(scan.filesRead)} of ${n(scan.filesInWindow)} files and found no assistant turns in the last ${windowLabel(ctx)}${scan.stoppedAtDeadline ? " (stopped at the deadline)" : ""}`,
        ),
      ];
    }
    const newest =
      scan.sessions.find((s) => s.sessionId === scan.newestSessionId) ??
      scan.sessions.reduce((a, b) => (lastTimestamp(b) > lastTimestamp(a) ? b : a));
    return [newestSessionRow(newest), ...fleetRows(ctx, scan)];
  },
};
