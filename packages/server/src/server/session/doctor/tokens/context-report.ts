import { existsSync } from "node:fs";
import path from "node:path";
import type { DoctorContext } from "../context.js";
import { auditAccounts, auditCwds, tokenAuditConfig, type AuditAccount } from "./settings.js";

/**
 * `claude -p "/context"` prints Claude Code's own context breakdown from a local command: no
 * model call (`duration_api_ms: 0`, `total_cost_usd: 0`), so it is the exact tokenizer's count
 * for the memory files, MCP tools and system prompt an agent would start with. It prints counts
 * rounded to three digits (`4k`, `8.6k`, `740`), so a value keeps the rounding step it carried.
 * Without `--no-session-persistence` it also writes a transcript, which the cache item would
 * then read back as spend.
 */

export interface TokenCount {
  value: number;
  /** Half the rounding step: `4k` is 4000 ± 500, `8.6k` is 8600 ± 50, `740` is 740 ± 0.5. */
  halfStep: number;
}

const UNIT_MULTIPLIER: Record<string, number> = { k: 1000, m: 1_000_000 };

/** `4k`, `8.6k`, `740`, `1m`, `1.2m`. Anything else (`~290`, `< 20`) is not a count. */
export function parseTokenCount(text: string): TokenCount | null {
  const match = /^\s*(\d+(?:\.(\d+))?)\s*([km]?)\s*$/i.exec(text);
  if (!match) return null;
  const unit = match[3]?.toLowerCase();
  const multiplier = UNIT_MULTIPLIER[unit ?? ""] ?? 1;
  const decimals = match[2]?.length ?? 0;
  return {
    value: Math.round(Number(match[1]) * multiplier),
    halfStep: (multiplier * 10 ** -decimals) / 2,
  };
}

export function formatTokenCount(count: TokenCount): string {
  return count.value >= 1000
    ? `${(count.value / 1000).toFixed(count.halfStep < 500 ? 1 : 0).replace(/\.0$/, "")}k`
    : String(count.value);
}

export interface ContextMemoryFile {
  type: string;
  path: string;
  tokens: TokenCount | null;
}

export interface ContextMcpTool {
  tool: string;
  server: string;
  tokens: TokenCount | null;
}

export interface ParsedContext {
  model: string | null;
  categories: Record<string, TokenCount>;
  memoryFiles: ContextMemoryFile[];
  mcpTools: ContextMcpTool[];
  /** Agents in the "Custom Agents" table, when Claude Code prints one. */
  customAgents: Array<{ name: string; source: string }>;
}

function tableRows(markdown: string, heading: RegExp): string[][] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return [];
  const rows: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    if (!line.trim().startsWith("|")) continue;
    const cells = line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => cell.trim());
    // Header and separator rows.
    if (cells.every((cell) => /^-+$/.test(cell)) || cells[0] === "Category") continue;
    if (["Type", "Tool", "Skill", "Agent", "Name"].includes(cells[0] ?? "")) continue;
    rows.push(cells);
  }
  return rows;
}

export function parseContextReport(markdown: string): ParsedContext {
  const model = /\*\*Model:\*\*\s*(\S+)/.exec(markdown)?.[1] ?? null;
  const categories: Record<string, TokenCount> = {};
  for (const [name, tokens] of tableRows(markdown, /^###\s+Estimated usage by category/)) {
    const count = parseTokenCount(tokens ?? "");
    if (name && count) categories[name] = count;
  }
  return {
    model,
    categories,
    memoryFiles: tableRows(markdown, /^###\s+Memory Files/).map(([type, file, tokens]) => ({
      type: type ?? "",
      path: file ?? "",
      tokens: parseTokenCount(tokens ?? ""),
    })),
    mcpTools: tableRows(markdown, /^###\s+MCP Tools\s*$/).map(([tool, server, tokens]) => ({
      tool: tool ?? "",
      server: server ?? "",
      tokens: parseTokenCount(tokens ?? ""),
    })),
    customAgents: tableRows(markdown, /^###\s+Custom Agents/).map(([name, source]) => ({
      name: name ?? "",
      source: source ?? "",
    })),
  };
}

export interface ContextRun {
  configDir: string;
  cwd: string;
  /** Null when the probe could not produce a report; `error` says why. */
  report: ParsedContext | null;
  error?: string;
}

function claudeBinary(ctx: DoctorContext): string {
  const local = path.join(
    ctx.home,
    ".local",
    "bin",
    ctx.platform === "win32" ? "claude.exe" : "claude",
  );
  return existsSync(local) ? local : "claude";
}

export interface RunContextInput {
  configDir: string;
  cwd: string;
  appendSystemPrompt?: string;
  timeoutMs: number;
}

export async function runContextProbe(
  ctx: DoctorContext,
  input: RunContextInput,
): Promise<ContextRun> {
  const args = ["-p", "/context", "--output-format", "json", "--no-session-persistence"];
  if (input.appendSystemPrompt !== undefined) {
    args.push("--append-system-prompt", input.appendSystemPrompt);
  }
  const result = await ctx.probes.exec(claudeBinary(ctx), args, {
    timeoutMs: input.timeoutMs,
    cwd: input.cwd,
    env: { ...ctx.env, CLAUDE_CONFIG_DIR: input.configDir },
  });
  const base = { configDir: input.configDir, cwd: input.cwd };
  if (!result) {
    return { ...base, report: null, error: "claude did not run or did not finish in time" };
  }
  try {
    const parsed = JSON.parse(result.stdout) as {
      result?: unknown;
      total_cost_usd?: unknown;
      duration_api_ms?: unknown;
    };
    if (typeof parsed.result !== "string" || !parsed.result.includes("## Context Usage")) {
      return { ...base, report: null, error: "claude printed no context breakdown" };
    }
    // The audit's promise is that it costs no tokens. A /context that billed something is a
    // Claude Code change worth knowing about, not a number to trust silently.
    if (
      (typeof parsed.total_cost_usd === "number" && parsed.total_cost_usd > 0) ||
      (typeof parsed.duration_api_ms === "number" && parsed.duration_api_ms > 0)
    ) {
      return { ...base, report: null, error: "claude -p /context made an API call; not used" };
    }
    return { ...base, report: parseContextReport(parsed.result) };
  } catch {
    return { ...base, report: null, error: "claude printed output that is not JSON" };
  }
}

const RUN_CAP_DEFAULT = 9;
const RUN_TIMEOUT_MS = 45_000;
const RUN_CONCURRENCY = 3;

const memo = new WeakMap<DoctorContext, Promise<ContextRuns>>();

export interface ContextRuns {
  accounts: AuditAccount[];
  cwds: string[];
  runs: ContextRun[];
}

/**
 * One `/context` run per account and audited directory, capped. Memory, tools, model and the
 * subagent item all read the same runs, so the memo keeps one audit to one set of subprocesses.
 */
export function collectContextRuns(ctx: DoctorContext): Promise<ContextRuns> {
  const existing = memo.get(ctx);
  if (existing) return existing;
  const work = (async (): Promise<ContextRuns> => {
    const accounts = auditAccounts(ctx);
    const cwds = auditCwds(ctx);
    const configured = tokenAuditConfig(ctx)["maxContextRuns"];
    const cap =
      typeof configured === "number" && configured > 0 ? Math.floor(configured) : RUN_CAP_DEFAULT;
    const plan: Array<{ configDir: string; cwd: string }> = [];
    // Every directory under the first account first, so the project-level view is complete
    // before a second account repeats it.
    for (const account of accounts) {
      for (const cwd of cwds.length > 0 ? cwds : [ctx.home]) {
        plan.push({ configDir: account.configDir, cwd });
      }
    }
    const runs: ContextRun[] = [];
    const queue = plan.slice(0, cap);
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        runs.push(await runContextProbe(ctx, { ...next, timeoutMs: RUN_TIMEOUT_MS }));
      }
    };
    await Promise.all(Array.from({ length: RUN_CONCURRENCY }, worker));
    return { accounts, cwds, runs };
  })();
  memo.set(ctx, work);
  return work;
}
