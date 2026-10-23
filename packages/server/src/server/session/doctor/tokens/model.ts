import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { DoctorContext } from "../context.js";
import {
  auditAccounts,
  auditCwds,
  envEntriesOf,
  newestSessionFiles,
  readAgentProcesses,
  readSettingsLayers,
  type AgentProcess,
  type AuditAccount,
  type SettingsLayer,
} from "./settings.js";
import { row, type TokenAuditCheck, type TokenAuditRow, type TokenSeverity } from "./types.js";

const SESSIONS_SCANNED = 60;
/** `opusplan` plans on Opus and executes on Sonnet: a switch at every plan-mode boundary. */
const AUTO_SWITCH_ALIASES = /^opusplan/i;

/** Highest precedence first. Managed settings win, then project over user. */
const PRECEDENCE: SettingsLayer["scope"][] = [
  "managed",
  "project-local",
  "project",
  "user-local",
  "user",
];

function effective(
  layers: SettingsLayer[],
  key: string,
): { value: unknown; layer: SettingsLayer } | null {
  for (const scope of PRECEDENCE) {
    for (const layer of layers.filter((l) => l.scope === scope)) {
      if (layer.data[key] !== undefined) return { value: layer.data[key], layer };
    }
  }
  return null;
}

export interface SessionModels {
  file: string;
  /** Distinct main-thread models in first-seen order. */
  models: string[];
  /** How many times the main thread's model changed from the previous turn's. */
  switches: number;
}

/** Main-thread models of one transcript; sub-agent turns run on their own model by design. */
export async function scanSessionModels(file: string): Promise<SessionModels> {
  const models: string[] = [];
  let previous: string | null = null;
  let switches = 0;
  const lines = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.includes('"type":"assistant"') || line.includes('"isSidechain":true')) continue;
    const model = /"model":"([^"]+)"/.exec(line)?.[1];
    if (!model || model === "<synthetic>") continue;
    if (!models.includes(model)) models.push(model);
    if (previous !== null && previous !== model) switches += 1;
    previous = model;
  }
  return { file, models, switches };
}

const MODEL_ENV =
  /^(ANTHROPIC_MODEL|ANTHROPIC_DEFAULT_[A-Z]+_MODEL|CLAUDE_CODE_SUBAGENT_MODEL|CLAUDE_CODE_EFFORT_LEVEL)$/;

interface SettingRow {
  row: TokenAuditRow;
  /** Configured ways the model can change on its own, found while reading this account. */
  autoSwitch: string[];
}

function settingRow(
  ctx: DoctorContext,
  account: AuditAccount,
  cwd: string | undefined,
): SettingRow {
  const layers = readSettingsLayers(ctx, { configDir: account.configDir, cwd }).layers;
  const model = effective(layers, "model");
  const effort = effective(layers, "effortLevel");
  const fallback = effective(layers, "fallbackModel");
  const configFile = path.join(ctx.paseoHome, "config.json");
  const envHits = layers.flatMap((layer) =>
    envEntriesOf(layer.data)
      .filter((entry) => MODEL_ENV.test(entry.name))
      .map((entry) => `${entry.name}=${entry.display} (${layer.path})`),
  );
  const providerEnv = account.providerEnv
    .filter((entry) => /MODEL|EFFORT/.test(entry.name))
    .map(
      (entry) =>
        `${entry.name}=${entry.display} (${configFile}, provider ${account.providers.join("+")})`,
    );
  const autoSwitch: string[] = [];
  if (typeof model?.value === "string" && AUTO_SWITCH_ALIASES.test(model.value)) {
    autoSwitch.push(`model "${model.value}" in ${model.layer.path}`);
  }
  if (fallback) {
    autoSwitch.push(`fallbackModel ${JSON.stringify(fallback.value)} in ${fallback.layer.path}`);
  }
  const modelText = model
    ? `model=${String(model.value)} set in ${model.layer.path}`
    : "model not set in any settings layer";
  const effortText = effort
    ? `effortLevel=${String(effort.value)} set in ${effort.layer.path}`
    : "effortLevel not set in any settings layer";
  return {
    autoSwitch,
    row: row(
      "model",
      `model:setting:${account.configDir}`,
      "GREEN",
      `Model settings for ${account.configDir}`,
      [modelText, effortText, ...envHits, ...providerEnv].join("; "),
      "the default model and effort for a session launched without --model/--effort",
    ),
  };
}

function launchRow(
  ctx: DoctorContext,
  processes: AgentProcess[] | null,
): { row: TokenAuditRow; autoSwitch: string[] } {
  if (processes === null) {
    const why =
      ctx.platform === "darwin" ? "ps failed" : `platform ${ctx.platform}; ps eww is macOS only`;
    return {
      autoSwitch: [],
      row: row(
        "model",
        "model:launch",
        "UNKNOWN",
        "Model and effort agents are launched with",
        `UNKNOWN: running agent processes not probed (${why})`,
        "UNKNOWN",
      ),
    };
  }
  const tally = new Map<string, number>();
  const autoSwitch: string[] = [];
  for (const proc of processes) {
    const key = `--model ${proc.model ?? "(none)"} --effort ${proc.effort ?? "(none)"} --thinking ${proc.thinking ?? "(none)"}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
    if (proc.fallbackModel) {
      autoSwitch.push(`--fallback-model ${proc.fallbackModel} on pid ${proc.pid}`);
    }
  }
  return {
    autoSwitch,
    row: row(
      "model",
      "model:launch",
      "GREEN",
      `${processes.length} running agent processes launched with ${tally.size} model/effort combinations`,
      [...tally].map(([key, n]) => `${n} × ${key}`).join("; ") || "no agent processes running",
      "the daemon sets --model, --effort and --thinking per agent from its classifier; these are what is running now",
    ),
  };
}

/** The spend governor's downgrade stage moves a running agent to a cheaper model. */
function governorSwitch(ctx: DoctorContext): string[] {
  const agents = ctx.rawConfig?.["agents"] as
    | { tokenBurnMonitor?: { governor?: Record<string, unknown> } }
    | undefined;
  const governor = agents?.tokenBurnMonitor?.governor;
  const downgrade = governor?.["downgrade"] as { enabled?: boolean } | undefined;
  const live =
    governor?.["enabled"] === true && governor["dryRun"] !== true && downgrade?.enabled !== false;
  if (!governor || !live) return [];
  const target = String(governor["downgradeToModel"] ?? "its default model");
  return [
    `agents.tokenBurnMonitor.governor downgrades to ${target} (live, not dry run) in ${path.join(ctx.paseoHome, "config.json")}`,
  ];
}

interface MeasuredSwitches {
  scanned: number;
  files: number;
  switched: SessionModels[];
}

/** Measured, not configured: sessions whose main thread changed model between turns. */
async function measureSwitches(ctx: DoctorContext, deadline: number): Promise<MeasuredSwitches> {
  const files = newestSessionFiles(ctx, SESSIONS_SCANNED);
  const switched: SessionModels[] = [];
  let scanned = 0;
  for (const { file } of files) {
    if (Date.now() > deadline) break;
    const result = await scanSessionModels(file);
    scanned += 1;
    if (result.switches > 0) switched.push(result);
  }
  return { scanned, files: files.length, switched };
}

function autoSwitchSeverity(configured: boolean, measured: MeasuredSwitches): TokenSeverity {
  if (configured) return "RED";
  if (measured.switched.length > 0) return "AMBER";
  return measured.files === 0 ? "UNKNOWN" : "GREEN";
}

function autoSwitchFinding(configured: boolean, measured: MeasuredSwitches): string {
  if (configured) return "A mode switches the model automatically mid-session";
  if (measured.switched.length > 0) {
    return `${measured.switched.length} of ${measured.scanned} recent sessions changed model mid-session`;
  }
  return "No automatic model switching found";
}

function autoSwitchEvidence(autoSwitch: string[], measured: MeasuredSwitches): string {
  if (measured.files === 0 && autoSwitch.length === 0) return "UNKNOWN: no transcripts to read";
  const examples = measured.switched
    .slice(0, 3)
    .map((s) => `${path.basename(s.file, ".jsonl").slice(0, 8)}: ${s.models.join(" → ")}`)
    .join("; ");
  const configured =
    autoSwitch.length > 0
      ? `configured: ${autoSwitch.join("; ")}`
      : "no opusplan, fallbackModel, --fallback-model or live governor downgrade";
  return `${configured}; ${measured.switched.length} of ${measured.scanned} newest sessions switched model (${examples || "none"})`;
}

export const modelCheck: TokenAuditCheck = {
  id: "tokens.model",
  item: "model",
  timeoutMs: 180_000,
  async measure(ctx: DoctorContext, deadline) {
    const cwd = auditCwds(ctx)[0];
    const settings = auditAccounts(ctx).map((account) => settingRow(ctx, account, cwd));
    const launch = launchRow(ctx, await readAgentProcesses(ctx));
    const autoSwitch = [
      ...settings.flatMap((setting) => setting.autoSwitch),
      ...launch.autoSwitch,
      ...governorSwitch(ctx),
    ];
    const measured = await measureSwitches(ctx, deadline);
    const configured = autoSwitch.length > 0;
    return [
      ...settings.map((setting) => setting.row),
      launch.row,
      row(
        "model",
        "model:auto-switch",
        autoSwitchSeverity(configured, measured),
        autoSwitchFinding(configured, measured),
        autoSwitchEvidence(autoSwitch, measured),
        "every model switch rebuilds the whole prompt cache at the new model's price",
        { "model.switchedSessions": measured.switched.length },
      ),
    ];
  },
};
