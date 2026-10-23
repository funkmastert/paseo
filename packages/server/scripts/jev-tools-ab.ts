/**
 * The D8 report for the JEV agent tools (docs/jev.md, "Features 4–6", Measurement). Read-only: it
 * joins `$PASEO_HOME/jev/tool-use.jsonl`, the stored agents' `paseo.jev-tools` arm labels and their
 * Claude transcripts, and prints per arm and task class what the tools cost against what they
 * saved, the regret reads, and the pre-registered kill rule's verdict.
 *
 *   npx tsx packages/server/scripts/jev-tools-ab.ts [--paseo-home <dir>] [--claude-dirs <a,b>]
 *     [--since <ISO>] [--format markdown|json]
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { TOKEN_BURN_WEIGHTS, weighTokenUsage } from "../src/server/agent/token-rate-tracker.js";
import {
  JEV_TOOL_NAMES,
  CLAUDE_CHARS_PER_TOKEN,
  JEV_TOOL_USE_FILE,
  JEV_TOOL_USE_ROTATED_FILE,
  type JevToolName,
  type JevToolUseRecord,
} from "../src/server/agent/tools/jev-tool-use-log.js";

const JEV_TOOLS_LABEL = "paseo.jev-tools";
const TASK_CLASS_LABEL = "paseo.task-class";
/** The kill rule waits for this many labelled agents with transcripts. */
export const KILL_RULE_MIN_AGENTS = 50;
/** An `ask_jev` command repeated in Bash within this many tool steps is a regret. */
const COMMAND_REGRET_STEPS = 5;
const SINGLE_FILE_TOOLS = new Set<JevToolName>([
  "ask_jev_file_bool",
  "ask_jev_file_choice",
  "ask_jev_file_score",
]);
const READ_COMMANDS = new Set(["cat", "head", "tail", "less", "more", "nl", "bat"]);

export const KILL_RULE_TEXT =
  "After 50 labelled agents, if the on arm's weighted spend per agent-hour within a task class is not lower than the control arm's beyond noise, set agentTools.enabled: false.";
export const NOISE_RULE_TEXT =
  "Noise: per task class, the on arm counts as lower only when its mean weighted spend per agent-hour is below the control arm's by more than one standard error of the difference (sqrt(se_on^2 + se_control^2)); a class needs at least 2 agents in each arm to be judged. The rule kills unless the on arm is lower in every judged class.";

export type Arm = "on" | "control";

export interface StoredAgent {
  id: string;
  arm: Arm;
  taskClass: string;
  createdAt: string;
  sessionIds: string[];
}

export interface ToolStep {
  at: number;
  name: string;
  input: Record<string, unknown>;
  cwd: string | null;
  resultChars: number;
}

export interface TranscriptSummary {
  weightedTokens: number;
  firstAt: number | null;
  lastAt: number | null;
  steps: ToolStep[];
}

export interface AgentMetrics {
  agent: StoredAgent;
  hours: number;
  weightedTokens: number;
  jevToolCalls: number;
  transcriptJevToolCalls: number;
  toolSearchSteps: number;
  jevResultTokens: number;
  readTokens: number;
  bashReadTokens: number;
  netReadTokensAvoided: number;
  byTool: Partial<Record<JevToolName, { calls: number; regretted: number }>>;
  filesAsked: number;
  filesLaterRead: number;
  diffRisk: { calls: number; needsFullReview: number; forcedBy: Record<string, number> };
}

// ---------------------------------------------------------------------------------------------
// Parsing

export function parseToolUseLines(text: string): JevToolUseRecord[] {
  const records: JevToolUseRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Partial<JevToolUseRecord>;
      if (value.v === 1 && typeof value.agentId === "string" && typeof value.tool === "string") {
        records.push(value as JevToolUseRecord);
      }
    } catch {
      // A torn last line from a crash mid-append.
    }
  }
  return records;
}

function readToolUse(paseoHome: string): JevToolUseRecord[] {
  const dir = path.join(paseoHome, "jev");
  return [JEV_TOOL_USE_ROTATED_FILE, JEV_TOOL_USE_FILE].flatMap((name) => {
    const file = path.join(dir, name);
    return existsSync(file) ? parseToolUseLines(readFileSync(file, "utf8")) : [];
  });
}

/** Every stored agent that carries a JEV arm label. */
export function readStoredAgents(paseoHome: string): StoredAgent[] {
  const root = path.join(paseoHome, "agents");
  if (!existsSync(root)) return [];
  const agents: StoredAgent[] = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of readdirSync(path.join(root, dir.name))) {
      if (!file.endsWith(".json")) continue;
      const agent = parseStoredAgent(path.join(root, dir.name, file));
      if (agent) agents.push(agent);
    }
  }
  return agents;
}

function parseStoredAgent(file: string): StoredAgent | null {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const labels = (record["labels"] ?? {}) as Record<string, string>;
  const arm = labels[JEV_TOOLS_LABEL];
  if ((arm !== "on" && arm !== "control") || typeof record["id"] !== "string") return null;
  const sessionIds = [
    (record["persistence"] as { sessionId?: unknown } | undefined)?.sessionId,
    (record["runtimeInfo"] as { sessionId?: unknown } | undefined)?.sessionId,
  ].filter((id): id is string => typeof id === "string" && id.length > 0);
  return {
    id: record["id"],
    arm,
    taskClass: labels[TASK_CLASS_LABEL]?.trim() || "unknown",
    createdAt: typeof record["createdAt"] === "string" ? record["createdAt"] : "",
    sessionIds: [...new Set(sessionIds)],
  };
}

/** `projects/` dirs of every Claude config dir, once each: accounts often symlink one shared dir. */
export function defaultClaudeDirs(home: string): string[] {
  return readdirSync(home)
    .filter((name) => name === ".claude" || name.startsWith(".claude-"))
    .map((name) => path.join(home, name))
    .filter((dir) => existsSync(path.join(dir, "projects")));
}

export function indexTranscripts(claudeDirs: string[]): Map<string, string> {
  const index = new Map<string, string>();
  const seenRoots = new Set<string>();
  for (const dir of claudeDirs) {
    const projects = path.join(dir, "projects");
    let real: string;
    try {
      real = realpathSync(projects);
    } catch {
      continue;
    }
    if (seenRoots.has(real)) continue;
    seenRoots.add(real);
    for (const project of readdirSync(real, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      for (const file of readdirSync(path.join(real, project.name))) {
        if (file.endsWith(".jsonl"))
          index.set(file.slice(0, -6), path.join(real, project.name, file));
      }
    }
  }
  return index;
}

function textLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      chars += (block as { text: string }).text.length;
    }
  }
  return chars;
}

interface TranscriptLine {
  type?: string;
  timestamp?: string;
  cwd?: string;
  message?: {
    id?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens?: number;
    };
  };
}

/**
 * Usage per assistant message, counted once: Claude writes one line per content block and repeats
 * the message's usage on each. Tool steps carry their result's size, joined by `tool_use_id`.
 */
export function parseTranscript(text: string): TranscriptSummary {
  const parsed = new TranscriptAccumulator();
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      parsed.add(JSON.parse(raw) as TranscriptLine);
    } catch {
      // A torn line.
    }
  }
  return parsed.summary();
}

type ContentBlock = Record<string, unknown>;

class TranscriptAccumulator {
  private readonly usageByMessage = new Map<string, number>();
  private readonly steps: ToolStep[] = [];
  private readonly stepById = new Map<string, ToolStep>();
  private firstAt: number | null = null;
  private lastAt: number | null = null;

  add(line: TranscriptLine): void {
    const at = line.timestamp ? Date.parse(line.timestamp) : Number.NaN;
    if (Number.isFinite(at)) {
      this.firstAt = this.firstAt === null ? at : Math.min(this.firstAt, at);
      this.lastAt = this.lastAt === null ? at : Math.max(this.lastAt, at);
    }
    const message = line.message;
    if (!message || !Array.isArray(message.content)) return;
    const blocks = message.content as ContentBlock[];
    if (line.type === "assistant") this.addAssistant(message, blocks, at, line.cwd ?? null);
    else if (line.type === "user") this.addToolResults(blocks);
  }

  summary(): TranscriptSummary {
    let weightedTokens = 0;
    for (const value of this.usageByMessage.values()) weightedTokens += value;
    return { weightedTokens, firstAt: this.firstAt, lastAt: this.lastAt, steps: this.steps };
  }

  private addAssistant(
    message: NonNullable<TranscriptLine["message"]>,
    blocks: ContentBlock[],
    at: number,
    cwd: string | null,
  ): void {
    const usage = message.usage;
    if (message.id && usage) {
      this.usageByMessage.set(
        message.id,
        weighTokenUsage({
          inputTokens: usage.input_tokens,
          cacheCreationInputTokens: usage.cache_creation_input_tokens,
          cacheReadInputTokens: usage.cache_read_input_tokens,
          outputTokens: usage.output_tokens,
        }),
      );
    }
    for (const block of blocks) {
      if (block["type"] !== "tool_use" || typeof block["name"] !== "string") continue;
      const step: ToolStep = {
        at: Number.isFinite(at) ? at : (this.lastAt ?? 0),
        name: block["name"],
        input: (block["input"] ?? {}) as Record<string, unknown>,
        cwd,
        resultChars: 0,
      };
      this.steps.push(step);
      if (typeof block["id"] === "string") this.stepById.set(block["id"], step);
    }
  }

  private addToolResults(blocks: ContentBlock[]): void {
    for (const block of blocks) {
      if (block["type"] !== "tool_result" || typeof block["tool_use_id"] !== "string") continue;
      const step = this.stepById.get(block["tool_use_id"]);
      if (step) step.resultChars += textLength(block["content"]);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Reads in a transcript

/** Leading `cd X &&` steps move the cwd the rest of the command reads from. */
function stripLeadingCd(command: string, cwd: string | null): { rest: string; cwd: string | null } {
  let rest = command.trim();
  let dir = cwd;
  const cdRe = /^cd\s+(\S+)\s*&&\s*/;
  for (let match = cdRe.exec(rest); match; match = cdRe.exec(rest)) {
    dir = resolveAgainst(match[1]!.replace(/^['"]|['"]$/g, ""), dir);
    rest = rest.slice(match[0].length);
  }
  return { rest, cwd: dir };
}

/** The files a Bash call reads, when its first command is a plain read; empty otherwise. */
export function bashReadPaths(command: string, cwd: string | null): string[] {
  const stripped = stripLeadingCd(command, cwd);
  const first = stripped.rest.split(/\||;|&&|>/)[0] ?? "";
  const words = first.split(/\s+/).filter((word) => word.length > 0);
  const head = words.at(0);
  const rest = words.slice(1);
  if (!head) return [];
  const isRead = READ_COMMANDS.has(head) || (head === "sed" && rest.includes("-n"));
  if (!isRead) return [];
  return rest
    .filter((word) => !word.startsWith("-") && !/^['"]?\d+(,\d+)?p['"]?$/.test(word))
    .map((word) => word.replace(/^['"]|['"]$/g, ""))
    .filter((word) => word.length > 0 && !/^\d+$/.test(word))
    .map((word) => resolveAgainst(word, stripped.cwd));
}

function resolveAgainst(file: string, cwd: string | null): string {
  if (file.startsWith("~/")) return path.join(os.homedir(), file.slice(2));
  if (path.isAbsolute(file) || !cwd) return path.normalize(file);
  return path.resolve(cwd, file);
}

function readPathsOf(step: ToolStep): string[] {
  if (step.name === "Read" && typeof step.input["file_path"] === "string") {
    return [resolveAgainst(step.input["file_path"], step.cwd)];
  }
  if (step.name === "Bash" && typeof step.input["command"] === "string") {
    return bashReadPaths(step.input["command"], step.cwd);
  }
  return [];
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** An `ask_jev` whose command the agent ran again in Bash within the next 5 tool steps. */
function commandRegretted(record: JevToolUseRecord, steps: ToolStep[]): boolean {
  if (!record.commandSha256) return false;
  const at = Date.parse(record.at);
  const own = steps.findIndex((step) => step.name.endsWith("ask_jev") && step.at >= at - 1_000);
  const start = own >= 0 ? own + 1 : steps.findIndex((step) => step.at > at);
  if (start < 0) return false;
  return steps
    .slice(start, start + COMMAND_REGRET_STEPS)
    .some(
      (step) =>
        step.name === "Bash" &&
        typeof step.input["command"] === "string" &&
        sha256(step.input["command"].trim()) === record.commandSha256,
    );
}

// ---------------------------------------------------------------------------------------------
// Per agent

export function measureAgent(
  agent: StoredAgent,
  transcript: TranscriptSummary,
  records: JevToolUseRecord[],
): AgentMetrics {
  const spanMs =
    transcript.firstAt !== null && transcript.lastAt !== null
      ? transcript.lastAt - transcript.firstAt
      : 0;
  const metrics: AgentMetrics = {
    agent,
    hours: Math.max(spanMs, 60_000) / 3_600_000,
    weightedTokens: transcript.weightedTokens,
    jevToolCalls: records.length,
    transcriptJevToolCalls: 0,
    toolSearchSteps: 0,
    jevResultTokens: 0,
    readTokens: 0,
    bashReadTokens: 0,
    netReadTokensAvoided: 0,
    byTool: {},
    filesAsked: 0,
    filesLaterRead: 0,
    diffRisk: { calls: 0, needsFullReview: 0, forcedBy: {} },
  };
  const jevNames = new Set(JEV_TOOL_NAMES.map((name) => `mcp__paseo__${name}`));
  for (const step of transcript.steps) {
    if (jevNames.has(step.name)) metrics.transcriptJevToolCalls += 1;
    if (step.name === "ToolSearch") metrics.toolSearchSteps += 1;
    const tokens = Math.ceil(step.resultChars / CLAUDE_CHARS_PER_TOKEN);
    if (step.name === "Read") metrics.readTokens += tokens;
    else if (step.name === "Bash" && readPathsOf(step).length > 0) metrics.bashReadTokens += tokens;
  }
  for (const record of records) {
    const resultTokens = Math.ceil(record.resultChars / CLAUDE_CHARS_PER_TOKEN);
    metrics.jevResultTokens += resultTokens;
    const stepCost = (record.callerContextTokens ?? 0) * TOKEN_BURN_WEIGHTS.cacheRead;
    metrics.netReadTokensAvoided += record.readTokensAvoided - resultTokens - stepCost;
    const tool = (metrics.byTool[record.tool] ??= { calls: 0, regretted: 0 });
    tool.calls += 1;
    if (record.diffRisk) {
      metrics.diffRisk.calls += 1;
      if (record.diffRisk.needsFullReview) metrics.diffRisk.needsFullReview += 1;
      for (const trigger of record.diffRisk.forcedBy) {
        const key = trigger.split(":")[0]!.trim();
        metrics.diffRisk.forcedBy[key] = (metrics.diffRisk.forcedBy[key] ?? 0) + 1;
      }
    }
    const later = transcript.steps.filter((step) => step.at > Date.parse(record.at));
    const laterReads = new Set(later.flatMap(readPathsOf));
    const read = record.paths.filter((file) => laterReads.has(path.normalize(file)));
    if (record.tool === "ask_jev_files") {
      metrics.filesAsked += record.paths.length;
      metrics.filesLaterRead += read.length;
    }
    const pathRegret = record.tool !== "ask_jev_files" && read.length > 0;
    if (pathRegret || commandRegretted(record, transcript.steps)) tool.regretted += 1;
  }
  return metrics;
}

// ---------------------------------------------------------------------------------------------
// Aggregation and the kill rule

export interface GroupSummary {
  arm: Arm;
  taskClass: string;
  agents: number;
  agentHours: number;
  /** Per-agent weighted tokens per hour: mean and standard error. */
  meanWeightedPerHour: number;
  seWeightedPerHour: number | null;
  jevToolCalls: number;
  toolSearchSteps: number;
  jevResultTokens: number;
  readTokens: number;
  bashReadTokens: number;
  netReadTokensAvoided: number;
}

function meanAndSe(values: number[]): { mean: number; se: number | null } {
  if (values.length === 0) return { mean: 0, se: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length < 2) return { mean, se: null };
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return { mean, se: Math.sqrt(variance / values.length) };
}

export function summarizeGroups(metrics: AgentMetrics[]): GroupSummary[] {
  const groups = new Map<string, AgentMetrics[]>();
  for (const entry of metrics) {
    const key = `${entry.agent.arm}\0${entry.agent.taskClass}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups.entries()]
    .map(([key, entries]) => {
      const [arm, taskClass] = key.split("\0") as [Arm, string];
      const rates = meanAndSe(entries.map((entry) => entry.weightedTokens / entry.hours));
      const sum = (pick: (entry: AgentMetrics) => number) =>
        entries.reduce((total, entry) => total + pick(entry), 0);
      return {
        arm,
        taskClass,
        agents: entries.length,
        agentHours: sum((entry) => entry.hours),
        meanWeightedPerHour: rates.mean,
        seWeightedPerHour: rates.se,
        jevToolCalls: sum((entry) => entry.jevToolCalls),
        toolSearchSteps: sum((entry) => entry.toolSearchSteps),
        jevResultTokens: sum((entry) => entry.jevResultTokens),
        readTokens: sum((entry) => entry.readTokens),
        bashReadTokens: sum((entry) => entry.bashReadTokens),
        netReadTokensAvoided: sum((entry) => entry.netReadTokensAvoided),
      };
    })
    .sort((a, b) => a.taskClass.localeCompare(b.taskClass) || a.arm.localeCompare(b.arm));
}

export interface KillVerdict {
  labelledAgents: number;
  verdict: "not-enough-agents" | "keep" | "switch-off";
  classes: Array<{
    taskClass: string;
    judged: boolean;
    onLower: boolean | null;
    difference: number | null;
    seDifference: number | null;
  }>;
  text: string;
}

export function evaluateKillRule(groups: GroupSummary[], labelledAgents: number): KillVerdict {
  const byClass = new Map<string, { on?: GroupSummary; control?: GroupSummary }>();
  for (const group of groups) {
    const entry = byClass.get(group.taskClass) ?? {};
    entry[group.arm] = group;
    byClass.set(group.taskClass, entry);
  }
  const classes = [...byClass.entries()].map(([taskClass, { on, control }]) => {
    const judged = Boolean(on && control && on.agents >= 2 && control.agents >= 2);
    if (
      !judged ||
      !on ||
      !control ||
      on.seWeightedPerHour === null ||
      control.seWeightedPerHour === null
    ) {
      return { taskClass, judged: false, onLower: null, difference: null, seDifference: null };
    }
    const difference = on.meanWeightedPerHour - control.meanWeightedPerHour;
    const seDifference = Math.sqrt(on.seWeightedPerHour ** 2 + control.seWeightedPerHour ** 2);
    return {
      taskClass,
      judged: true,
      onLower: difference < -seDifference,
      difference,
      seDifference,
    };
  });
  if (labelledAgents < KILL_RULE_MIN_AGENTS) {
    return {
      labelledAgents,
      verdict: "not-enough-agents",
      classes,
      text: `not enough agents yet (${labelledAgents} of ${KILL_RULE_MIN_AGENTS})`,
    };
  }
  const judged = classes.filter((entry) => entry.judged);
  const keep = judged.length > 0 && judged.every((entry) => entry.onLower === true);
  return {
    labelledAgents,
    verdict: keep ? "keep" : "switch-off",
    classes,
    text: keep
      ? "keep: the on arm is lower beyond noise in every judged task class"
      : "switch off: set agents.jev.agentTools.enabled: false",
  };
}

// ---------------------------------------------------------------------------------------------
// The report

export interface Report {
  generatedAt: string;
  agents: { labelled: number; withTranscript: number; withoutTranscript: number };
  groups: GroupSummary[];
  tools: Array<{
    tool: JevToolName;
    calls: number;
    regretted: number;
    rate: number | null;
    switchOff: boolean;
  }>;
  askJevFiles: { filesAsked: number; filesLaterRead: number };
  diffRisk: { calls: number; needsFullReview: number; forcedBy: Record<string, number> };
  killRule: KillVerdict;
}

export function buildReport(input: {
  agents: StoredAgent[];
  records: JevToolUseRecord[];
  transcripts: Map<string, string>;
  readText: (file: string) => string;
  since?: number;
  now?: Date;
}): Report {
  const agents = input.agents.filter(
    (agent) => input.since === undefined || Date.parse(agent.createdAt) >= input.since,
  );
  const recordsByAgent = new Map<string, JevToolUseRecord[]>();
  for (const record of input.records) {
    recordsByAgent.set(record.agentId, [...(recordsByAgent.get(record.agentId) ?? []), record]);
  }
  const metrics: AgentMetrics[] = [];
  let withoutTranscript = 0;
  for (const agent of agents) {
    const files = agent.sessionIds
      .map((id) => input.transcripts.get(id))
      .filter((file): file is string => file !== undefined);
    if (files.length === 0) {
      withoutTranscript += 1;
      continue;
    }
    const transcript = parseTranscript(files.map((file) => input.readText(file)).join("\n"));
    metrics.push(measureAgent(agent, transcript, recordsByAgent.get(agent.id) ?? []));
  }
  const tools = JEV_TOOL_NAMES.map((tool) => {
    let calls = 0;
    let regretted = 0;
    for (const entry of metrics) {
      calls += entry.byTool[tool]?.calls ?? 0;
      regretted += entry.byTool[tool]?.regretted ?? 0;
    }
    const rate = calls > 0 ? regretted / calls : null;
    return {
      tool,
      calls,
      regretted,
      rate,
      switchOff: SINGLE_FILE_TOOLS.has(tool) && rate !== null && rate > 0.5,
    };
  });
  const diffRisk = { calls: 0, needsFullReview: 0, forcedBy: {} as Record<string, number> };
  for (const entry of metrics) {
    diffRisk.calls += entry.diffRisk.calls;
    diffRisk.needsFullReview += entry.diffRisk.needsFullReview;
    for (const [key, count] of Object.entries(entry.diffRisk.forcedBy)) {
      diffRisk.forcedBy[key] = (diffRisk.forcedBy[key] ?? 0) + count;
    }
  }
  const groups = summarizeGroups(metrics);
  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    agents: { labelled: agents.length, withTranscript: metrics.length, withoutTranscript },
    groups,
    tools,
    askJevFiles: {
      filesAsked: metrics.reduce((sum, entry) => sum + entry.filesAsked, 0),
      filesLaterRead: metrics.reduce((sum, entry) => sum + entry.filesLaterRead, 0),
    },
    diffRisk,
    killRule: evaluateKillRule(groups, metrics.length),
  };
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export function renderMarkdown(report: Report): string {
  const lines = [
    `# JEV agent tools: D8 report (${report.generatedAt})`,
    "",
    `Labelled agents: ${report.agents.labelled}; with a transcript: ${report.agents.withTranscript}; transcript not found: ${report.agents.withoutTranscript}.`,
    "",
    "| task class | arm | agents | agent-hours | weighted/agent-hour (± se) | JEV calls | ToolSearch | JEV result tok | Read tok | Bash-read tok | net read tok avoided |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.groups.map(
      (group) =>
        `| ${group.taskClass} | ${group.arm} | ${group.agents} | ${group.agentHours.toFixed(2)} | ${formatNumber(group.meanWeightedPerHour)}${group.seWeightedPerHour === null ? "" : ` ± ${formatNumber(group.seWeightedPerHour)}`} | ${group.jevToolCalls} | ${group.toolSearchSteps} | ${formatNumber(group.jevResultTokens)} | ${formatNumber(group.readTokens)} | ${formatNumber(group.bashReadTokens)} | ${formatNumber(group.netReadTokensAvoided)} |`,
    ),
    "",
    "## Regret reads",
    "",
    "| tool | calls | regretted | rate | switch off |",
    "| --- | --- | --- | --- | --- |",
    ...report.tools.map(
      (tool) =>
        `| ${tool.tool} | ${tool.calls} | ${tool.regretted} | ${tool.rate === null ? "-" : `${Math.round(tool.rate * 100)}%`} | ${tool.switchOff ? "yes" : "no"} |`,
    ),
    "",
    `ask_jev_files: ${report.askJevFiles.filesLaterRead} of ${report.askJevFiles.filesAsked} files asked about were read later.`,
    "",
    "## Diff risk",
    "",
    `${report.diffRisk.calls} calls, ${report.diffRisk.needsFullReview} said needs_full_review. Forced by: ${
      Object.entries(report.diffRisk.forcedBy)
        .map(([key, count]) => `${key} ${count}`)
        .join(", ") || "none"
    }.`,
    "",
    "## Kill rule",
    "",
    KILL_RULE_TEXT,
    "",
    NOISE_RULE_TEXT,
    "",
    ...report.killRule.classes.map((entry) =>
      entry.judged
        ? `- ${entry.taskClass}: on − control = ${formatNumber(entry.difference ?? 0)} (se ${formatNumber(entry.seDifference ?? 0)}); on lower beyond noise: ${entry.onLower ? "yes" : "no"}`
        : `- ${entry.taskClass}: not judged (fewer than 2 agents in an arm)`,
    ),
    "",
    `**Verdict: ${report.killRule.text}.**`,
  ];
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------
// CLI

interface CliOptions {
  paseoHome: string;
  claudeDirs: string[];
  since?: number;
  format: "markdown" | "json";
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv, home: string): CliOptions {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const since = value("--since");
  const format = value("--format");
  return {
    paseoHome: value("--paseo-home") ?? env["PASEO_HOME"] ?? path.join(home, ".paseo"),
    claudeDirs: value("--claude-dirs")?.split(",").filter(Boolean) ?? defaultClaudeDirs(home),
    ...(since ? { since: Date.parse(since) } : {}),
    format: format === "json" ? "json" : "markdown",
  };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2), process.env, os.homedir());
  const report = buildReport({
    agents: readStoredAgents(options.paseoHome),
    records: readToolUse(options.paseoHome),
    transcripts: indexTranscripts(options.claudeDirs),
    readText: (file) => (statSync(file).isFile() ? readFileSync(file, "utf8") : ""),
    since: options.since,
  });
  process.stdout.write(
    options.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
