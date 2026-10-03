import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * The daemon's heartbeat file. A watchdog thread rewrites it every second, so it stays current
 * while the main thread is blocked and the websocket is silent. `paseo daemon status` reads it
 * straight off disk: the one moment a probe over the socket cannot answer is the moment this
 * file is most useful.
 */
export const DAEMON_VITALS_FILENAME = "daemon-vitals.json";
export const DIAGNOSTICS_DIRNAME = "diagnostics";
export const DAEMON_VITALS_SCHEMA = "paseo.daemon-vitals/v1";

/** A heartbeat older than this means the writer thread itself stopped. */
export const HEARTBEAT_STALE_MS = 5_000;

const EpisodeSchema = z.object({
  kind: z.enum(["wedge", "stall", "suspension"]),
  startedAt: z.string(),
  endedAt: z.string(),
  blockedMs: z.number(),
  suspendedMs: z.number(),
  cpuRatio: z.number(),
  cause: z.enum(["busy", "blocked"]),
});

const SummarySchema = z.object({
  lag: z.object({ p50Ms: z.number(), p99Ms: z.number(), maxMs: z.number() }).nullable().optional(),
  counts: z.object({ wedges: z.number(), stalls: z.number(), suspensions: z.number() }),
  episodes: z.array(EpisodeSchema),
});

export const DaemonVitalsFileSchema = z.object({
  schema: z.literal(DAEMON_VITALS_SCHEMA),
  pid: z.number(),
  startedAt: z.string(),
  /** Wall clock of the watchdog thread's last write. */
  updatedAtMs: z.number(),
  /** Set by a clean stop; a file without it that stops updating is a daemon that did not stop. */
  stoppedAt: z.string().optional(),
  /** Wall clock of the main thread's last tick. */
  mainTickAtMs: z.number(),
  /** How long the main thread has been blocked as of `updatedAtMs`, net of suspension. */
  mainBlockedMs: z.number(),
  thresholds: z.object({
    tickMs: z.number(),
    slowStallMs: z.number(),
    wedgeMs: z.number(),
    suspendMs: z.number(),
  }),
  dryRun: z.boolean(),
  summary: SummarySchema.nullable(),
});

export type DaemonVitalsFile = z.infer<typeof DaemonVitalsFileSchema>;
export type DaemonVitalsEpisode = z.infer<typeof EpisodeSchema>;

export function daemonVitalsPath(paseoHome: string): string {
  return path.join(paseoHome, DIAGNOSTICS_DIRNAME, DAEMON_VITALS_FILENAME);
}

export type VitalsReadResult =
  | { status: "missing" }
  | { status: "unreadable"; error: string }
  | { status: "ok"; file: DaemonVitalsFile };

export function readDaemonVitals(paseoHome: string): VitalsReadResult {
  let raw: string;
  try {
    raw = readFileSync(daemonVitalsPath(paseoHome), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "unreadable", error: error instanceof Error ? error.message : String(error) };
  }
  try {
    return { status: "ok", file: DaemonVitalsFileSchema.parse(JSON.parse(raw)) };
  } catch (error) {
    return { status: "unreadable", error: error instanceof Error ? error.message : String(error) };
  }
}

export type VitalsVerdict =
  /** Vitals were never written: disabled, or a daemon older than this feature. */
  | { state: "not-reporting" }
  | { state: "stopped" }
  /** The watchdog thread is silent too: the whole process is suspended or gone, not just blocked. */
  | { state: "silent"; silentMs: number }
  | { state: "healthy" }
  /** The main loop is late but the daemon is still answering. */
  | { state: "slow"; blockedMs: number }
  /** The main loop is blocked past the wedge threshold. The process is alive, not down. */
  | { state: "wedged"; blockedMs: number };

/**
 * Reads a verdict off the file alone. "Wedged" and "slow" come from the loop metric, never from
 * a probe deadline, so a daemon that is merely busy is never reported down.
 */
export function deriveVitalsVerdict(file: DaemonVitalsFile | null, nowMs: number): VitalsVerdict {
  if (!file) return { state: "not-reporting" };
  if (file.stoppedAt) return { state: "stopped" };
  const silentMs = nowMs - file.updatedAtMs;
  if (silentMs > Math.max(HEARTBEAT_STALE_MS, file.thresholds.suspendMs)) {
    return { state: "silent", silentMs };
  }
  if (file.mainBlockedMs >= file.thresholds.wedgeMs) {
    return { state: "wedged", blockedMs: file.mainBlockedMs };
  }
  if (file.mainBlockedMs >= file.thresholds.slowStallMs) {
    return { state: "slow", blockedMs: file.mainBlockedMs };
  }
  return { state: "healthy" };
}

/** The most recent wedge in the file's episode list, if the daemon has seen one this run. */
export function lastWedge(file: DaemonVitalsFile | null): DaemonVitalsEpisode | null {
  const episodes = file?.summary?.episodes ?? [];
  for (let index = episodes.length - 1; index >= 0; index -= 1) {
    if (episodes[index]?.kind === "wedge") return episodes[index] ?? null;
  }
  return null;
}

export function describeVitalsVerdict(verdict: VitalsVerdict): string {
  switch (verdict.state) {
    case "not-reporting":
      return "not reporting";
    case "stopped":
      return "stopped";
    case "silent":
      return `no heartbeat for ${Math.round(verdict.silentMs / 1000)}s (process suspended or stopped)`;
    case "healthy":
      return "healthy";
    case "slow":
      return `slow (event loop blocked ${(verdict.blockedMs / 1000).toFixed(1)}s)`;
    case "wedged":
      return `wedged (event loop blocked ${Math.round(verdict.blockedMs / 1000)}s; process is alive)`;
  }
}
