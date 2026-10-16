import {
  readLatestSaturationIncident,
  saturationLedgerPath,
} from "../../agent/saturation-ledger.js";
import { finding, type DoctorCheck } from "./context.js";
import { formatBytes, formatDuration } from "./helpers.js";

const WINDOW_MS = 7 * 86_400_000;

function describeLoad(load1: number, cores: number | undefined): string {
  return `peak load ${load1.toFixed(1)}${cores ? ` on ${cores} cores` : ""}`;
}

/**
 * The most recent CPU saturation incident in the resource monitor's ledger. The ledger is
 * written with an fdatasync per record so it survives the reboot these incidents tend to end in;
 * this is where a person looks afterwards. See docs/resource-monitor.md.
 */
export const saturationCheck: DoctorCheck = {
  id: "resource.saturation",
  category: "resource",
  timeoutMs: 5_000,
  async run(ctx) {
    const nowMs = ctx.now();
    const incident = await readLatestSaturationIncident({
      paseoHome: ctx.paseoHome,
      nowMs,
      windowMs: WINDOW_MS,
    });
    if (!incident) {
      return [
        finding("resource.saturation", "resource", "ok", "No CPU saturation in the last 7 days"),
      ];
    }

    const { peak } = incident;
    const cores = peak.load?.cores;
    const ended = incident.clearedAt
      ? `lasted ${formatDuration(incident.durationMs)}`
      : `never cleared: the last record is ${formatDuration(nowMs - Date.parse(incident.lastAt))} old, so the daemon or the machine stopped during it`;
    const lines = [
      `Opened ${incident.openedAt}; ${ended}.`,
      `Cause at the peak: ${peak.evidence.cause.kind}` +
        (peak.evidence.sample.status === "stale"
          ? ` (process sample ${Math.round(peak.evidence.sample.ageMs / 1000)}s old)`
          : ""),
      ...peak.evidence.agentTrees.map(
        (tree) =>
          `Agent ${tree.title ?? tree.agentId} (${tree.agentId}${tree.cwd ? `, ${tree.cwd}` : ""}): ` +
          `${tree.cpuPercent}% CPU, ${formatBytes(tree.rssBytes)}` +
          (tree.topCommands.length > 0
            ? `; ${tree.topCommands.map((command) => `${command.name} ${command.cpuPercent}%`).join(", ")}`
            : ""),
      ),
      ...peak.evidence.otherProcesses
        .slice(0, 3)
        .map((process) => `Other: ${process.name} pid ${process.pid}, ${process.cpuPercent}% CPU`),
    ];
    const ledger = saturationLedgerPath(ctx.paseoHome);
    return [
      finding(
        "resource.saturation",
        "resource",
        "warn",
        `CPU saturated ${formatDuration(nowMs - Date.parse(incident.openedAt))} ago, ${describeLoad(incident.peakLoad1, cores)}`,
        {
          detail: lines.join("\n"),
          why: "A saturated machine starves the daemon and every agent at once, and the last one ended in a forced reboot.",
          fix:
            ctx.platform === "win32" ? `Get-Content "${ledger}" -Tail 5` : `tail -n 5 '${ledger}'`,
        },
      ),
    ];
  },
};
