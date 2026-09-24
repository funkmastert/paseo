import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { DoctorContext } from "../context.js";
import { realpathOrNull } from "../helpers.js";
import {
  collectContextRuns,
  formatTokenCount,
  runContextProbe,
  type ContextRun,
  type TokenCount,
} from "./context-report.js";
import { auditAccounts, auditCwds } from "./settings.js";
import { row, type TokenAuditCheck, type TokenAuditRow, type TokenSeverity } from "./types.js";

/** Tyler's thresholds: flag any single memory file over 5k tokens and a total over 10k. */
export const MEMORY_FILE_LIMIT_TOKENS = 5_000;
export const MEMORY_TOTAL_LIMIT_TOKENS = 10_000;

const APPEND_PROMPT_MAX_ARG_BYTES = 100_000;

/** RED when the count is over the limit even at the low end of its rounding, AMBER when it straddles. */
export function gradeAgainst(count: TokenCount, limit: number): TokenSeverity {
  if (count.value - count.halfStep > limit) return "RED";
  if (count.value + count.halfStep > limit) return "AMBER";
  return "GREEN";
}

function precision(count: TokenCount): string {
  return `${formatTokenCount(count)} as printed, ±${count.halfStep >= 1 ? Math.round(count.halfStep) : count.halfStep}`;
}

interface FileEntry {
  type: string;
  path: string;
  tokens: TokenCount;
  seenIn: string[];
}

/** Every memory file across the runs, once per real path, keeping the largest count printed. */
function uniqueFiles(runs: ContextRun[]): FileEntry[] {
  const byReal = new Map<string, FileEntry>();
  for (const run of runs) {
    for (const file of run.report?.memoryFiles ?? []) {
      if (!file.tokens) continue;
      const key = realpathOrNull(file.path) ?? file.path;
      const existing = byReal.get(key);
      if (!existing) {
        byReal.set(key, {
          type: file.type,
          path: file.path,
          tokens: file.tokens,
          seenIn: [run.cwd],
        });
        continue;
      }
      if (file.tokens.value > existing.tokens.value) existing.tokens = file.tokens;
      if (!existing.seenIn.includes(run.cwd)) existing.seenIn.push(run.cwd);
    }
  }
  return [...byReal.values()];
}

function bytesOf(file: string): number | null {
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
}

// ---- static fallback: no exact counts ---------------------------------------------------------

const IMPORT = /(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[\w.~/-]+\.[\w]+)/g;

/**
 * CLAUDE.md files Claude Code would load from this directory, with their `@imports`. Used only
 * when `claude -p /context` is unavailable, and then only for sizes in bytes.
 */
export function discoverMemoryFiles(
  ctx: Pick<DoctorContext, "home">,
  input: { configDir: string; cwd: string },
): string[] {
  const found = new Set<string>();
  const queue: Array<{ file: string; depth: number }> = [];
  const add = (file: string, depth: number) => {
    const real = realpathOrNull(file);
    if (!real || found.has(real)) return;
    found.add(real);
    queue.push({ file: real, depth });
  };
  add(path.join(input.configDir, "CLAUDE.md"), 0);
  for (let dir = input.cwd; ; dir = path.dirname(dir)) {
    add(path.join(dir, "CLAUDE.md"), 0);
    add(path.join(dir, ".claude", "CLAUDE.md"), 0);
    add(path.join(dir, "CLAUDE.local.md"), 0);
    if (path.dirname(dir) === dir) break;
  }
  for (let item = queue.shift(); item; item = queue.shift()) {
    if (item.depth >= 5) continue;
    let text: string;
    try {
      text = readFileSync(item.file, "utf8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(IMPORT)) {
      const target = match[1] as string;
      const resolved = target.startsWith("~/")
        ? path.join(ctx.home, target.slice(2))
        : path.resolve(path.dirname(item.file), target);
      if (statSync(resolved, { throwIfNoEntry: false })?.isFile()) add(resolved, item.depth + 1);
    }
  }
  return [...found];
}

function staticRows(ctx: DoctorContext, reason: string): TokenAuditRow[] {
  const cwds = auditCwds(ctx);
  const accounts = auditAccounts(ctx);
  const files = new Set<string>();
  for (const account of accounts) {
    for (const cwd of cwds.length > 0 ? cwds : [ctx.home]) {
      for (const file of discoverMemoryFiles(ctx, { configDir: account.configDir, cwd })) {
        files.add(file);
      }
    }
  }
  const rows: TokenAuditRow[] = [];
  let totalBytes = 0;
  for (const file of files) {
    const bytes = bytesOf(file);
    totalBytes += bytes ?? 0;
    rows.push(
      row(
        "memory",
        `memory:file:${file}`,
        "UNKNOWN",
        `CLAUDE.md file ${file}`,
        `${bytes === null ? "unreadable" : `${bytes} bytes`}; tokens UNKNOWN (${reason})`,
        "UNKNOWN",
      ),
    );
  }
  rows.push(
    row(
      "memory",
      "memory:total",
      "UNKNOWN",
      "Total memory across CLAUDE.md files",
      `${files.size} files, ${totalBytes} bytes; tokens UNKNOWN (${reason})`,
      "UNKNOWN",
    ),
  );
  return rows;
}

// ---- appendSystemPrompt ----------------------------------------------------------------------

function appendSystemPrompt(ctx: DoctorContext): string | null {
  const daemon = ctx.rawConfig?.["daemon"] as Record<string, unknown> | undefined;
  const value = daemon?.["appendSystemPrompt"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface AppendMeasure {
  tokens: TokenCount;
  bytes: number;
  before: TokenCount;
  after: TokenCount;
}

/**
 * The daemon's `appendSystemPrompt` rides in every agent's prefix. Its size in tokens is the
 * difference in the "System prompt" line between two `/context` runs, one with it and one
 * without. Bytes are reported too, and never divided by four: on this fork's own prompt that
 * guess is a third short.
 */
async function measureAppend(
  ctx: DoctorContext,
  text: string,
  baseline: ContextRun,
): Promise<AppendMeasure | string> {
  const bytes = Buffer.byteLength(text);
  if (bytes > APPEND_PROMPT_MAX_ARG_BYTES) {
    return `${bytes} bytes is too large to pass on a command line`;
  }
  const before = baseline.report?.categories["System prompt"];
  if (!before) return "the baseline /context printed no System prompt line";
  const withAppend = await runContextProbe(ctx, {
    configDir: baseline.configDir,
    cwd: baseline.cwd,
    appendSystemPrompt: text,
    timeoutMs: 45_000,
  });
  const after = withAppend.report?.categories["System prompt"];
  if (!after) return withAppend.error ?? "the run with the prompt printed no System prompt line";
  return {
    tokens: { value: after.value - before.value, halfStep: after.halfStep + before.halfStep },
    bytes,
    before,
    after,
  };
}

function appendRow(
  ctx: DoctorContext,
  measured: AppendMeasure | string,
  bytes: number,
): TokenAuditRow {
  if (typeof measured === "string") {
    return row(
      "memory",
      "memory:append-system-prompt",
      "UNKNOWN",
      "daemon.appendSystemPrompt (in every agent's prefix)",
      `${bytes} bytes in ${path.join(ctx.paseoHome, "config.json")}; tokens UNKNOWN (${measured})`,
      "UNKNOWN",
    );
  }
  return row(
    "memory",
    "memory:append-system-prompt",
    gradeAgainst(measured.tokens, MEMORY_FILE_LIMIT_TOKENS),
    "daemon.appendSystemPrompt (in every agent's prefix)",
    `${measured.tokens.value} tokens ±${Math.round(measured.tokens.halfStep)} (System prompt ${formatTokenCount(measured.before)} → ${formatTokenCount(measured.after)} in claude -p /context); ${measured.bytes} bytes in ${path.join(ctx.paseoHome, "config.json")}`,
    `${measured.tokens.value} tokens on the first turn of every agent, then re-read from cache on every turn`,
    { "memory.appendTokens": measured.tokens.value },
  );
}

// ---- the check -------------------------------------------------------------------------------

function fileRows(runs: ContextRun[]): TokenAuditRow[] {
  return uniqueFiles(runs).map((file) =>
    row(
      "memory",
      `memory:file:${realpathOrNull(file.path) ?? file.path}`,
      gradeAgainst(file.tokens, MEMORY_FILE_LIMIT_TOKENS),
      `${file.type} memory file ${file.path}`,
      `${precision(file.tokens)}; limit ${MEMORY_FILE_LIMIT_TOKENS}; loaded in ${file.seenIn.length} audited dir${file.seenIn.length === 1 ? "" : "s"}`,
      `${file.tokens.value} tokens on the first turn of every agent that loads it, then re-read from cache on every turn`,
      { "memory.fileTokens": file.tokens.value },
    ),
  );
}

function memoryFilesTokens(run: ContextRun): number {
  return run.report?.categories["Memory files"]?.value ?? 0;
}

/** One total per audited directory: the largest any account printed, with the appended prompt. */
function totalRows(good: ContextRun[], append: AppendMeasure | null): TokenAuditRow[] {
  const byCwd = new Map<string, ContextRun>();
  for (const run of good) {
    const current = byCwd.get(run.cwd);
    if (!current || memoryFilesTokens(run) > memoryFilesTokens(current)) byCwd.set(run.cwd, run);
  }
  const rows: TokenAuditRow[] = [];
  for (const [cwd, run] of byCwd) {
    const memory = run.report?.categories["Memory files"];
    if (!memory) continue;
    const total: TokenCount = append
      ? {
          value: memory.value + append.tokens.value,
          halfStep: memory.halfStep + append.tokens.halfStep,
        }
      : memory;
    const appendNote = append ? ` + appendSystemPrompt ${append.tokens.value}` : "";
    rows.push(
      row(
        "memory",
        `memory:total:${cwd}`,
        gradeAgainst(total, MEMORY_TOTAL_LIMIT_TOKENS),
        `Total memory loaded from ${cwd}`,
        `${total.value} tokens ±${Math.round(total.halfStep)}: Memory files ${formatTokenCount(memory)} (${run.configDir})${appendNote}; limit ${MEMORY_TOTAL_LIMIT_TOKENS}`,
        `${total.value} tokens in the prefix of every agent started there, cache-written once then read every turn`,
        { "memory.totalTokens": total.value },
      ),
    );
  }
  return rows;
}

function failedRunsRow(runs: ContextRun[]): TokenAuditRow[] {
  const failed = runs.filter((run) => run.report === null);
  if (failed.length === 0) return [];
  return [
    row(
      "memory",
      "memory:runs-failed",
      "UNKNOWN",
      "Some /context runs did not finish",
      `UNKNOWN: ${failed.length} of ${runs.length} runs failed (${failed[0]?.error})`,
      "UNKNOWN",
    ),
  ];
}

export const memoryCheck: TokenAuditCheck = {
  id: "tokens.memory",
  item: "memory",
  timeoutMs: 180_000,
  async measure(ctx) {
    const { runs } = await collectContextRuns(ctx);
    const good = runs.filter((run) => run.report !== null);
    if (good.length === 0) {
      const reason = runs[0]?.error ?? "no account directory to run it in";
      return staticRows(ctx, `claude -p /context unavailable: ${reason}`);
    }
    const rows = fileRows(good);
    const text = appendSystemPrompt(ctx);
    let append: AppendMeasure | null = null;
    if (text !== null) {
      const measured = await measureAppend(ctx, text, good[0] as ContextRun);
      rows.push(appendRow(ctx, measured, Buffer.byteLength(text)));
      if (typeof measured !== "string") append = measured;
    }
    return [...rows, ...totalRows(good, append), ...failedRunsRow(runs)];
  },
};
