import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import chalk, { Chalk } from "chalk";
import type { Command } from "commander";
import {
  buildDoctorContext,
  countSeverities,
  renderTokenAuditTable,
  runDoctorChecks,
  runTokenAudit,
  type TokenAuditRow,
} from "@getpaseo/server";
import type { DoctorFinding } from "@getpaseo/protocol/doctor/rpc-schemas";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginListItem } from "@getpaseo/protocol/messages";
import { tryConnectToDaemon } from "../utils/client.js";
import type { CommandOptions, OutputOptions, OutputSchema, SingleResult } from "../output/index.js";

export interface DoctorReport {
  /** Where the checks ran. `cli` means the daemon could not run them itself. */
  source: "daemon" | "cli";
  generatedAt: string;
  daemonVersion: string | null;
  summary: { fail: number; warn: number; skip: number; ok: number };
  findings: DoctorFinding[];
  /** Why the checks ran where they did, when that is not the obvious place. */
  note?: string;
}

export interface DoctorOptions extends CommandOptions {
  host?: string;
  home?: string;
  deep?: boolean;
  full?: boolean;
  tokens?: boolean;
}

export interface TokenAuditCliReport {
  generatedAt: string;
  counts: ReturnType<typeof countSeverities>;
  rows: TokenAuditRow[];
}

const RANK: Record<DoctorFinding["status"], number> = { fail: 0, warn: 1, skip: 2, ok: 3 };
const MARK: Record<DoctorFinding["status"], string> = { fail: "✗", warn: "!", skip: "-", ok: "✓" };

function summarize(findings: DoctorFinding[]): DoctorReport["summary"] {
  const summary = { fail: 0, warn: 0, skip: 0, ok: 0 };
  for (const finding of findings) summary[finding.status] += 1;
  return summary;
}

function sortFindings(findings: DoctorFinding[]): DoctorFinding[] {
  return [...findings].sort(
    (a, b) => RANK[a.status] - RANK[b.status] || a.category.localeCompare(b.category),
  );
}

/** Resolves the home without `resolvePaseoHome`'s mkdir/chmod: doctor changes nothing. */
function resolveHomeReadOnly(explicit: string | undefined): string {
  const raw = explicit ?? process.env["PASEO_HOME"] ?? "~/.paseo";
  const expanded =
    raw === "~" || raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(1)) : raw;
  return path.resolve(expanded);
}

function readWorkspacesFromDisk(paseoHome: string) {
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(paseoHome, "projects", "workspaces.json"), "utf8"),
    );
    const records: unknown[] = Array.isArray(parsed)
      ? parsed
      : Object.values(parsed?.workspaces ?? parsed ?? {});
    return records.flatMap((record) => {
      const r = record as Record<string, unknown>;
      return typeof r?.["cwd"] === "string"
        ? [
            {
              cwd: r["cwd"],
              baseBranch: typeof r["baseBranch"] === "string" ? r["baseBranch"] : null,
              archivedAt: typeof r["archivedAt"] === "string" ? r["archivedAt"] : null,
              pinned: typeof r["pinnedAt"] === "string",
            },
          ]
        : [];
    });
  } catch {
    return null;
  }
}

async function attempt<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch {
    return null;
  }
}

async function failedPluginLogs(
  client: DaemonClient | null,
  plugins: PluginListItem[] | null,
): Promise<Map<string, string[]>> {
  const logs = new Map<string, string[]>();
  for (const plugin of plugins ?? []) {
    if (plugin.status !== "failed" || !client) continue;
    const entries = await attempt(() => client.getPluginLogs(plugin.id));
    logs.set(
      plugin.id,
      (entries ?? []).map((entry) => `${entry.stream}: ${entry.message}`),
    );
  }
  return logs;
}

/** Runs the checks in this process, with daemon facts pulled through RPCs every daemon answers. */
async function runLocally(
  client: DaemonClient | null,
  options: DoctorOptions,
  note: string,
): Promise<DoctorReport> {
  const paseoHome = resolveHomeReadOnly(options.home);
  const status = client ? await attempt(() => client.getDaemonStatus({ timeout: 5000 })) : null;
  const plugins = client ? await attempt(() => client.listPlugins()) : null;
  const usage = client ? await attempt(() => client.listProviderUsage()) : null;
  const agents = client ? await attempt(() => client.fetchAgents({})) : null;
  const pluginLogs = await failedPluginLogs(client, plugins);
  const ctx = buildDoctorContext({
    paseoHome,
    deep: options.deep === true,
    facts: {
      source: "cli",
      daemon: status
        ? {
            version: status.version ?? null,
            startedAt: status.startedAt ?? null,
            pid: status.pid,
            execPath: status.nodePath,
          }
        : null,
      plugins:
        plugins?.map((plugin) => ({
          id: plugin.id,
          path: plugin.path,
          enabled: plugin.enabled,
          status: plugin.status,
          error: plugin.error,
        })) ?? null,
      pluginLogs: (id) => pluginLogs.get(id) ?? [],
      agents:
        agents?.entries.map(({ agent }) => ({
          cwd: agent.cwd,
          status: agent.status,
          archived: Boolean(agent.archivedAt),
        })) ?? null,
      workspaces: readWorkspacesFromDisk(paseoHome),
      usage: usage?.providers ?? null,
    },
  });
  const findings = sortFindings(await runDoctorChecks(ctx));
  return {
    source: "cli",
    generatedAt: new Date().toISOString(),
    daemonVersion: status?.version ?? null,
    summary: summarize(findings),
    findings,
    note,
  };
}

/**
 * `paseo doctor --tokens`: the token audit, on demand. Every check reads files and the process
 * table, or runs `claude -p /context`, which makes no API call, so it needs no daemon and runs here.
 */
export async function runTokenAuditCommand(
  options: DoctorOptions,
  _command: Command,
): Promise<SingleResult<TokenAuditCliReport>> {
  const paseoHome = resolveHomeReadOnly(options.home);
  const ctx = buildDoctorContext({
    paseoHome,
    facts: {
      source: "cli",
      daemon: null,
      plugins: null,
      agents: null,
      workspaces: null,
      usage: null,
    },
  });
  process.stderr.write("Measuring the seven token audit items (about 30 seconds)...\n");
  const rows = await runTokenAudit(ctx);
  const counts = countSeverities(rows);
  if (counts.RED > 0) process.exitCode = 1;
  return {
    type: "single",
    data: { generatedAt: new Date().toISOString(), counts, rows },
    schema: {
      idField: () => "token-audit",
      columns: [],
      renderHuman(result) {
        if (result.type !== "single") return "";
        const { data } = result;
        return [
          renderTokenAuditTable(data.rows),
          "",
          `${data.counts.RED} RED, ${data.counts.AMBER} AMBER, ${data.counts.GREEN} GREEN, ${data.counts.UNKNOWN} UNKNOWN. Measured, not estimated; UNKNOWN means the probe could not run. Nothing was changed and no model was called.`,
        ].join("\n");
      },
    },
  };
}

export async function runDoctorCommand(
  options: DoctorOptions,
  _command: Command,
): Promise<SingleResult<DoctorReport>> {
  const client = await tryConnectToDaemon({ host: options.host });
  try {
    let report: DoctorReport;
    if (client?.supportsDaemonDoctor()) {
      try {
        // The daemon gives every check its own deadline, so this outer wait only bounds a wedge.
        const payload = await client.runDaemonDoctor({
          deep: options.deep === true,
          timeout: options.deep ? 6 * 60_000 : 90_000,
        });
        const findings = sortFindings(payload.findings);
        report = {
          source: "daemon",
          generatedAt: payload.generatedAt,
          daemonVersion: payload.daemonVersion ?? null,
          summary: summarize(findings),
          findings,
        };
      } catch (error) {
        report = await runLocally(
          client,
          options,
          `The daemon could not run the checks itself (${error instanceof Error ? error.message : String(error)}); they ran in the CLI instead.`,
        );
      }
    } else if (client) {
      report = await runLocally(
        client,
        options,
        "The running daemon predates `paseo doctor`, so the checks ran in the CLI against the same files and the daemon's existing RPCs. Checks that need the daemon's own code are marked below.",
      );
    } else {
      report = await runLocally(
        null,
        options,
        "No daemon answered, so the checks ran in the CLI without daemon state.",
      );
    }
    if (report.summary.fail > 0) process.exitCode = 1;
    return { type: "single", data: report, schema: createDoctorSchema(options.full === true) };
  } finally {
    await client?.close();
  }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}

export function renderDoctorHuman(
  report: DoctorReport,
  options: Pick<OutputOptions, "noColor"> & { full?: boolean },
): string {
  const c = options.noColor ? new Chalk({ level: 0 }) : chalk;
  const paint: Record<DoctorFinding["status"], (text: string) => string> = {
    fail: c.red,
    warn: c.yellow,
    skip: c.gray,
    ok: c.green,
  };
  const { summary } = report;
  const headline =
    summary.fail + summary.warn === 0
      ? "Nothing needs attention"
      : [
          summary.fail > 0 && plural(summary.fail, "problem"),
          summary.warn > 0 && plural(summary.warn, "warning"),
        ]
          .filter(Boolean)
          .join(", ");
  const lines = [
    c.bold(`paseo doctor: ${headline}`) +
      c.gray(
        ` (ran in the ${report.source === "daemon" ? "daemon" : "CLI"}${report.daemonVersion ? `, daemon ${report.daemonVersion}` : ""})`,
      ),
  ];
  if (report.note) lines.push(c.gray(report.note));
  lines.push("");

  const shown = report.findings.filter(
    (f) => options.full || f.status === "fail" || f.status === "warn",
  );
  for (const f of shown) {
    lines.push(`${paint[f.status](`${MARK[f.status]} ${f.category}`)}  ${f.title}`);
    if (f.status === "ok" && !options.full) continue;
    if (f.detail) lines.push(indent(f.detail, 4));
    if (f.why) lines.push(indent(`${c.gray("why:")} ${f.why}`, 4));
    if (f.fix) lines.push(indent(`${c.cyan("fix:")} ${f.fix}`, 4));
    lines.push("");
  }
  const quiet = report.findings.filter((f) => !shown.includes(f));
  if (quiet.length > 0) {
    const skipped = quiet.filter((f) => f.status === "skip").length;
    lines.push(
      c.gray(
        `${plural(quiet.length - skipped, "check")} passed${skipped > 0 ? `, ${skipped} skipped` : ""} (--full lists them)`,
      ),
    );
    lines.push("");
  }
  lines.push(
    summary.fail + summary.warn > 0
      ? "Doctor changed nothing. Run the fix commands above, then `paseo doctor` again to confirm."
      : "Doctor changed nothing. Nothing to do.",
  );
  return lines.join("\n");
}

export function createDoctorSchema(full: boolean): OutputSchema<DoctorReport> {
  return {
    idField: () => "doctor",
    columns: [],
    renderHuman(result, outputOptions) {
      if (result.type !== "single") return "";
      return renderDoctorHuman(result.data, { noColor: outputOptions.noColor, full });
    },
  };
}
