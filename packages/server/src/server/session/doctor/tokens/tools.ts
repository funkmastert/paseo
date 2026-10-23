import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { DoctorContext } from "../context.js";
import { collectContextRuns, formatTokenCount, type ContextRun } from "./context-report.js";
import {
  auditAccounts,
  envEntriesOf,
  isGatewayName,
  newestSessionFiles,
  readAgentProcesses,
  readSettingsLayers,
  type AgentProcess,
} from "./settings.js";
import { row, type TokenAuditCheck, type TokenAuditRow, type TokenSeverity } from "./types.js";

/** More tools than this loaded on every turn, with deferral off, is worth a look. */
export const MCP_TOOL_LOADED_LIMIT = 40;

const MCP_NAME = /mcp__([A-Za-z0-9_-]+?)__([A-Za-z0-9_-]+)/g;
const SCAN_FILES = 8;

export interface TranscriptToolScan {
  file: string;
  /** server → unique tool names seen (called, or listed in a deferred-tools reminder). */
  servers: Map<string, Set<string>>;
  toolSearchCalls: number;
  deferredListings: number;
  calledTools: Set<string>;
}

/**
 * One transcript's MCP inventory. A tool counts when the session called it or the harness listed
 * it in a "deferred tools" reminder; a name that only appears in prose does not.
 */
export async function scanTranscriptTools(file: string): Promise<TranscriptToolScan> {
  const scan: TranscriptToolScan = {
    file,
    servers: new Map(),
    toolSearchCalls: 0,
    deferredListings: 0,
    calledTools: new Set(),
  };
  const add = (server: string, tool: string) => {
    const tools = scan.servers.get(server) ?? new Set<string>();
    tools.add(tool);
    scan.servers.set(server, tools);
  };
  const lines = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (line.includes('"name":"ToolSearch"')) scan.toolSearchCalls += 1;
    const listing = /deferred tools/i.test(line) && line.includes("mcp__");
    if (listing) scan.deferredListings += 1;
    if (!line.includes("mcp__")) continue;
    if (listing) {
      for (const match of line.matchAll(MCP_NAME)) add(match[1] as string, match[2] as string);
    }
    for (const match of line.matchAll(/"name":"mcp__([A-Za-z0-9_-]+?)__([A-Za-z0-9_-]+)"/g)) {
      add(match[1] as string, match[2] as string);
      scan.calledTools.add(`${match[1]}__${match[2]}`);
    }
  }
  return scan;
}

interface EnvHit {
  name: string;
  display: string;
  where: string;
}

function gatewayHits(
  ctx: DoctorContext,
  processes: AgentProcess[] | null,
): { hits: EnvHit[]; searchToolDisabled: EnvHit | null; scanned: string[] } {
  const hits: EnvHit[] = [];
  const scanned: string[] = [];
  const consider = (entries: Array<{ name: string; display: string }>, where: string): void => {
    for (const entry of entries) {
      if (isGatewayName(entry.name)) hits.push({ ...entry, where });
      if (/^ENABLE_TOOL_SEARCH$/i.test(entry.name)) hits.push({ ...entry, where });
    }
  };
  for (const account of auditAccounts(ctx)) {
    consider(
      account.providerEnv,
      `${path.join(ctx.paseoHome, "config.json")} provider ${account.providers.join("+")}`,
    );
    scanned.push(`${account.configDir} settings`);
    for (const layer of readSettingsLayers(ctx, { configDir: account.configDir }).layers) {
      consider(envEntriesOf(layer.data), layer.path);
    }
  }
  scanned.push(`${path.join(ctx.paseoHome, "config.json")} providers`);
  consider(
    Object.entries(ctx.env).flatMap(([name, value]) =>
      isGatewayName(name) || /^ENABLE_TOOL_SEARCH$/i.test(name)
        ? [{ name, display: value ? "<set>" : "<empty>" }]
        : [],
    ),
    "this process's environment (agents inherit the daemon's)",
  );
  scanned.push("this process's environment");
  if (processes) {
    for (const proc of processes) consider(proc.env, `agent process ${proc.pid}`);
    scanned.push(`${processes.length} running agent processes`);
  }
  const dedup = new Map<string, EnvHit>();
  for (const hit of hits) dedup.set(`${hit.name}|${hit.where}`, hit);
  const unique = [...dedup.values()];
  const disabled =
    unique.find(
      (hit) => /^ENABLE_TOOL_SEARCH$/i.test(hit.name) && /^(false|0)$/i.test(hit.display),
    ) ?? null;
  return {
    hits: unique.filter((hit) => !/^ENABLE_TOOL_SEARCH$/i.test(hit.name)),
    searchToolDisabled: disabled,
    scanned,
  };
}

function loadedTokens(runs: ContextRun[]): string {
  const run = runs.find((r) => r.report?.categories["MCP tools"]);
  if (!run?.report) return "UNKNOWN";
  const loaded = run.report.categories["MCP tools"];
  const deferred = run.report.categories["MCP tools (deferred)"];
  return `/context: ${loaded ? formatTokenCount(loaded) : "0"} tokens of MCP tools loaded, ${deferred ? formatTokenCount(deferred) : "0"} deferred (${run.configDir})`;
}

type Deferral = "ACTIVE" | "NOT ACTIVE" | "UNKNOWN";

interface TranscriptEvidence {
  /** The newest transcript that shows any MCP tool. */
  scan: TranscriptToolScan | null;
  scanned: number;
  toolSearchCalls: number;
  deferredListings: number;
}

async function readTranscripts(ctx: DoctorContext, deadline: number): Promise<TranscriptEvidence> {
  const evidence: TranscriptEvidence = {
    scan: null,
    scanned: 0,
    toolSearchCalls: 0,
    deferredListings: 0,
  };
  const candidates = newestSessionFiles(ctx, SCAN_FILES);
  evidence.scanned = candidates.length;
  for (const candidate of candidates) {
    if (Date.now() > deadline) break;
    const result = await scanTranscriptTools(candidate.file);
    evidence.toolSearchCalls += result.toolSearchCalls;
    evidence.deferredListings += result.deferredListings;
    if (!evidence.scan && result.servers.size > 0) evidence.scan = result;
  }
  return evidence;
}

/**
 * What agents actually ran with decides. A standalone `claude -p /context` has none of the env an
 * agent launches with (a proxy, `ENABLE_TOOL_SEARCH`), so it only answers when there is no
 * transcript to read. Every session with deferral on carries a deferred-tools listing.
 */
function decideDeferral(transcripts: TranscriptEvidence, runs: ContextRun[]): Deferral {
  if (transcripts.scanned > 0) {
    return transcripts.toolSearchCalls > 0 || transcripts.deferredListings > 0
      ? "ACTIVE"
      : "NOT ACTIVE";
  }
  if (runs.some((run) => run.report !== null)) {
    return runs.some(reportsDeferredTools) ? "ACTIVE" : "NOT ACTIVE";
  }
  return "UNKNOWN";
}

function reportsDeferredTools(run: ContextRun): boolean {
  return (
    (run.report?.categories["MCP tools (deferred)"]?.value ?? 0) > 0 ||
    (run.report?.categories["System tools (deferred)"]?.value ?? 0) > 0
  );
}

function serverRows(scan: TranscriptToolScan, deferral: Deferral, cost: string): TokenAuditRow[] {
  return [...scan.servers]
    .sort((a, b) => b[1].size - a[1].size)
    .map(([server, tools]) => {
      const used = [...tools].filter((tool) => scan.calledTools.has(`${server}__${tool}`)).length;
      const flagged = deferral === "NOT ACTIVE" && tools.size >= 10;
      return row(
        "tools",
        `tools:server:${server}`,
        flagged ? "AMBER" : "GREEN",
        `MCP server ${server}: ${tools.size} tools`,
        `${tools.size} unique mcp__${server}__* names (${used} called) in ${path.basename(scan.file)}`,
        deferral === "ACTIVE"
          ? "names only until a tool is searched for; schemas load on use"
          : `${tools.size} tool schemas load on every turn; ${cost}`,
        { "tools.serverTools": tools.size },
      );
    });
}

function totalSeverity(deferral: Deferral, total: number): TokenSeverity {
  if (deferral === "UNKNOWN") return "UNKNOWN";
  return deferral === "NOT ACTIVE" && total > MCP_TOOL_LOADED_LIMIT ? "AMBER" : "GREEN";
}

function totalRow(
  scan: TranscriptToolScan | null,
  deferral: Deferral,
  cost: string,
): TokenAuditRow {
  if (!scan) {
    return row(
      "tools",
      "tools:total",
      totalSeverity(deferral, 0),
      "MCP servers and tool counts",
      "UNKNOWN: no transcript under the shared projects dir mentions an MCP tool",
      cost,
    );
  }
  const total = [...scan.servers.values()].reduce((sum, set) => sum + set.size, 0);
  return row(
    "tools",
    "tools:total",
    totalSeverity(deferral, total),
    `${scan.servers.size} MCP servers exposing ${total} tools`,
    `${total} unique tool names across ${scan.servers.size} servers in ${scan.file}`,
    cost,
    { "tools.total": total },
  );
}

function deferralRow(input: {
  deferral: Deferral;
  transcripts: TranscriptEvidence;
  runs: ContextRun[];
  disabledBy: EnvHit | null;
}): TokenAuditRow {
  const { deferral, transcripts, runs, disabledBy } = input;
  const contextDeferred = runs.find(reportsDeferredTools);
  const evidence = [
    `${transcripts.toolSearchCalls} ToolSearch calls and ${transcripts.deferredListings} deferred-tools listings in the newest ${transcripts.scanned} transcripts`,
    contextDeferred
      ? `a standalone /context shows deferred categories (${contextDeferred.configDir})`
      : `${runs.filter((run) => run.report !== null).length} /context runs show no deferred category`,
  ].join("; ");
  let severity: TokenSeverity = "RED";
  if (deferral === "UNKNOWN") severity = "UNKNOWN";
  else if (deferral === "ACTIVE" && !disabledBy) severity = "GREEN";
  let detail = evidence;
  if (disabledBy) {
    detail = `ENABLE_TOOL_SEARCH=${disabledBy.display} in ${disabledBy.where}; ${evidence}`;
  } else if (deferral === "UNKNOWN") {
    detail = "UNKNOWN: no transcript and no /context run to read";
  }
  return row(
    "tools",
    "tools:deferral",
    severity,
    `Tool deferral is ${disabledBy ? "DISABLED by ENABLE_TOOL_SEARCH" : deferral}`,
    detail,
    deferral === "ACTIVE"
      ? "MCP tool schemas stay out of the prefix until searched"
      : "every MCP tool schema is in the prefix of every turn",
  );
}

function proxyRow(input: {
  ctx: DoctorContext;
  deferral: Deferral;
  hits: EnvHit[];
  scanned: string[];
  processes: AgentProcess[] | null;
}): TokenAuditRow {
  const { ctx, deferral, hits, scanned, processes } = input;
  if (hits.length === 0) {
    const notProbed =
      processes === null
        ? `; agent processes not probed (${ctx.platform === "darwin" ? "ps failed" : `platform ${ctx.platform}`})`
        : "";
    return row(
      "tools",
      "tools:proxy",
      "GREEN",
      "No proxy or gateway variable set",
      `none found in: ${scanned.join(", ")}${notProbed}`,
      "deferral is not at risk from a proxy",
    );
  }
  return row(
    "tools",
    "tools:proxy",
    deferral === "ACTIVE" ? "AMBER" : "RED",
    `${hits.length} proxy or gateway variables set`,
    hits.map((hit) => `${hit.name}=${hit.display} (${hit.where})`).join("; "),
    `a proxy can silently turn tool deferral off; deferral is ${deferral}`,
  );
}

function gatewayConfigRow(ctx: DoctorContext): TokenAuditRow[] {
  const gateway = ctx.rawConfig?.["mcpGateway"] as
    | { enabled?: unknown; servers?: Record<string, unknown> }
    | undefined;
  if (!gateway || typeof gateway !== "object") return [];
  const names = Object.keys(gateway.servers ?? {});
  return [
    row(
      "tools",
      "tools:mcp-gateway",
      "GREEN",
      `Paseo MCP gateway injects ${names.length} servers into agents`,
      `mcpGateway.enabled=${String(gateway.enabled)} in ${path.join(ctx.paseoHome, "config.json")}: ${names.join(", ")}`,
      "these servers' tools are counted above from the transcript, not from config",
    ),
  ];
}

export const toolsCheck: TokenAuditCheck = {
  id: "tokens.tools",
  item: "tools",
  timeoutMs: 180_000,
  async measure(ctx, deadline) {
    const [{ runs }, processes] = await Promise.all([
      collectContextRuns(ctx),
      readAgentProcesses(ctx),
    ]);
    const transcripts = await readTranscripts(ctx, deadline);
    const deferral = decideDeferral(transcripts, runs);
    const cost = loadedTokens(runs);
    const { hits, searchToolDisabled, scanned } = gatewayHits(ctx, processes);
    return [
      ...(transcripts.scan ? serverRows(transcripts.scan, deferral, cost) : []),
      totalRow(transcripts.scan, deferral, cost),
      deferralRow({ deferral, transcripts, runs, disabledBy: searchToolDisabled }),
      proxyRow({ ctx, deferral, hits, scanned, processes }),
      ...gatewayConfigRow(ctx),
    ];
  },
};
