import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import path from "node:path";
import {
  parseCronExpression,
  type ParsedCronExpression,
} from "@getpaseo/protocol/schedule/cron-expression";
import type { DoctorContext } from "../context.js";
import { expandPathLike } from "../helpers.js";
import {
  row,
  severityRank,
  type TokenAuditCheck,
  type TokenAuditRow,
  type TokenSeverity,
} from "./types.js";

export interface CacheLifetimeMeasurement {
  lifetimeMs: number | null;
  oneHourTokens: number;
  fiveMinTokens: number;
}

export interface ScheduledCheckOptions {
  measureCacheLifetime?: (
    ctx: DoctorContext,
    deadline: number,
  ) => Promise<CacheLifetimeMeasurement>;
}

const MAX_JOB_ROWS = 40;
const SCRIPT_READ_BYTES = 64 * 1024;
const EXEC_TIMEOUT_MS = 10_000;
const CLAUDE_PATTERN = /claude|paseo|anthropic/i;
/** Days of fires the cron reader looks at for the smallest gap. */
const GAP_WINDOW_DAYS = 7;
/** A cron that fires fewer than twice in the window is searched this far for its first two fires. */
const GAP_SEARCH_DAYS = 400;
const CRASH_LOOP_RUNS = 50;
const DEFAULT_THROTTLE_SECONDS = 10;
const DAY_SECONDS = 86_400;

type Source = "paseo" | "cron" | "launchd";

/** What is known about one scheduled thing before it is compared with the cache lifetime. */
interface Job {
  source: Source;
  key: string;
  /** Shown in the finding. */
  name: string;
  /** Null when it could not be derived; `unknownWhy` says why. */
  intervalSec: number | null;
  /** How the interval was derived: `StartInterval`, `cron "0 * * * *"`. */
  derivation: string;
  unknownWhy?: string;
  /** No timer at all (`@reboot`, a launchd job with only KeepAlive/RunAtLoad). */
  noTimer?: string;
  callsClaude: boolean;
}

// ---- cron interval -------------------------------------------------------------------------------

const CRON_ALIASES: Record<string, string | null> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@reboot": null,
};

/**
 * Smallest gap in seconds between consecutive fires of any of `exprs`, scanning minute by minute
 * from `startMs`: the next 7 days, and when that holds fewer than two fires, up to 400 days until
 * two are found. Fields are read in UTC; a time zone shifts every fire alike, so it changes no gap
 * except across a DST change.
 */
export function minGapSeconds(exprs: ParsedCronExpression[], startMs: number): number | null {
  const firstMinute = Math.floor(startMs / 60_000) + 1;
  const windowEnd = firstMinute + GAP_WINDOW_DAYS * 1440;
  const searchEnd = firstMinute + GAP_SEARCH_DAYS * 1440;
  let previous: number | null = null;
  let smallest: number | null = null;
  let fires = 0;
  for (let minute = firstMinute; minute < searchEnd; minute += 1) {
    if (minute >= windowEnd && fires >= 2) break;
    const d = new Date(minute * 60_000);
    const hit = exprs.some(
      (e) =>
        e.minute.matches(d.getUTCMinutes()) &&
        e.hour.matches(d.getUTCHours()) &&
        e.dayOfMonth.matches(d.getUTCDate()) &&
        e.month.matches(d.getUTCMonth() + 1) &&
        e.dayOfWeek.matches(d.getUTCDay()),
    );
    if (!hit) continue;
    fires += 1;
    if (previous !== null) {
      const gap = (minute - previous) * 60;
      if (smallest === null || gap < smallest) smallest = gap;
    }
    previous = minute;
    // Past the window the first gap is all a sparse cron has; stop at it.
    if (minute >= windowEnd && smallest !== null) break;
  }
  return smallest;
}

function humanizeSeconds(value: number): string {
  if (value % DAY_SECONDS === 0) return `${value / DAY_SECONDS} d`;
  if (value % 3600 === 0) return `${value / 3600} h`;
  if (value % 60 === 0) return `${value / 60} min`;
  return `${value} s`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function shortHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 10);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readHead(file: string): string {
  let fd: number | null = null;
  try {
    if (!statSync(file).isFile()) return "";
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(SCRIPT_READ_BYTES);
    const bytes = readSync(fd, buffer, 0, SCRIPT_READ_BYTES, 0);
    return buffer.subarray(0, bytes).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function absolutePathTokens(tokens: readonly string[], ctx: DoctorContext): string[] {
  return tokens
    .filter((t) => t.startsWith("/") || t.startsWith("~/"))
    .map((t) => expandPathLike(t, ctx.home, ctx.env));
}

/** True when the text, or the first 64 KB of a script file it names, mentions claude/paseo/anthropic. */
function referencesClaude(text: string, tokens: readonly string[], ctx: DoctorContext): boolean {
  if (CLAUDE_PATTERN.test(text)) return true;
  return absolutePathTokens(tokens, ctx).some((file) => CLAUDE_PATTERN.test(readHead(file)));
}

// ---- Paseo schedules -----------------------------------------------------------------------------

function paseoJobs(ctx: DoctorContext): Job[] {
  const dir = path.join(ctx.paseoHome, "schedules");
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
  const jobs: Job[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const fallbackId = name.slice(0, -".json".length);
    let stored: Record<string, unknown>;
    try {
      stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch (error) {
      jobs.push({
        source: "paseo",
        key: `scheduled:paseo:${fallbackId}`,
        name: fallbackId,
        intervalSec: null,
        derivation: file,
        unknownWhy: `${file} is not readable JSON: ${errorMessage(error)}`,
        callsClaude: true,
      });
      continue;
    }
    if (stored.status !== "active") continue;
    const id = typeof stored.id === "string" ? stored.id : fallbackId;
    const label = typeof stored.name === "string" && stored.name ? stored.name : id;
    const job: Job = {
      source: "paseo",
      key: `scheduled:paseo:${id}`,
      name: label,
      intervalSec: null,
      derivation: "",
      // Every Paseo schedule runs an agent, which runs claude.
      callsClaude: true,
    };
    const cadence = stored.cadence as Record<string, unknown> | undefined;
    if (cadence?.type === "every" && typeof cadence.everyMs === "number" && cadence.everyMs > 0) {
      job.intervalSec = Math.round(cadence.everyMs / 1000);
      job.derivation = `every ${cadence.everyMs} ms`;
    } else if (cadence?.type === "cron" && typeof cadence.expression === "string") {
      job.derivation = `cron "${cadence.expression}"`;
      try {
        job.intervalSec = minGapSeconds([parseCronExpression(cadence.expression)], ctx.now());
        if (job.intervalSec === null)
          job.unknownWhy = `${job.derivation} fires fewer than twice in ${GAP_SEARCH_DAYS} days`;
      } catch (error) {
        job.unknownWhy = `cron expression "${cadence.expression}" could not be parsed: ${errorMessage(error)}`;
      }
    } else {
      job.unknownWhy = `${file} has no readable cadence`;
    }
    jobs.push(job);
  }
  return jobs;
}

// ---- crontab -------------------------------------------------------------------------------------

function processCronLine(line: string, ctx: DoctorContext): Job | null {
  if (!line || line.startsWith("#") || /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) {
    return null;
  }
  const alias = /^(@\S+)\s+(.+)$/.exec(line);
  const fields = alias ? null : /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/.exec(line);
  const schedule = alias?.[1] ?? fields?.[1];
  const command = alias?.[2] ?? fields?.[2];
  const key = `scheduled:cron:${shortHash(line)}`;
  if (schedule === undefined || command === undefined) {
    return {
      source: "cron",
      key,
      name: truncate(line, 60),
      intervalSec: null,
      derivation: `line "${truncate(line, 120)}"`,
      unknownWhy: `crontab line "${truncate(line, 120)}" has no schedule and command`,
      callsClaude: false,
    };
  }
  const tokens = command.split(/\s+/);
  const job: Job = {
    source: "cron",
    key,
    name: truncate(command, 60),
    intervalSec: null,
    derivation: `cron "${schedule}", command: ${truncate(command, 120)}`,
    callsClaude: referencesClaude(command, tokens, ctx),
  };
  const expression = schedule.startsWith("@") ? CRON_ALIASES[schedule] : schedule;
  if (expression === null) {
    job.noTimer = `${schedule}: runs once at boot; command: ${truncate(command, 120)}`;
  } else if (expression === undefined) {
    job.unknownWhy = `unknown crontab alias "${schedule}"; command: ${truncate(command, 120)}`;
  } else {
    try {
      job.intervalSec = minGapSeconds([parseCronExpression(expression)], ctx.now());
      if (job.intervalSec === null) {
        job.unknownWhy = `cron "${schedule}" fires fewer than twice in ${GAP_SEARCH_DAYS} days; command: ${truncate(command, 120)}`;
      }
    } catch (error) {
      job.unknownWhy = `cron expression "${schedule}" could not be parsed (${errorMessage(error)}); command: ${truncate(command, 120)}`;
    }
  }
  return job;
}

async function cronJobs(ctx: DoctorContext, unknownRows: TokenAuditRow[]): Promise<Job[]> {
  const result = await ctx.probes.exec("crontab", ["-l"], { timeoutMs: EXEC_TIMEOUT_MS });
  if (result === null) {
    unknownRows.push(
      row(
        "scheduled",
        "scheduled:cron",
        "UNKNOWN",
        "cron: crontab -l could not run",
        "UNKNOWN: crontab did not start or timed out",
        "UNKNOWN",
      ),
    );
    return [];
  }
  // "no crontab for <user>" exits non-zero: an empty crontab, not an error.
  if (result.code !== 0) return [];
  const jobs: Job[] = [];
  for (const raw of result.stdout.split("\n")) {
    const job = processCronLine(raw.trim(), ctx);
    if (job !== null) jobs.push(job);
  }
  return jobs;
}

// ---- launchd -------------------------------------------------------------------------------------

interface LaunchdAgent {
  label: string;
  plistPath: string;
  args: string[];
  keepAlive: boolean;
  runAtLoad: boolean;
  throttleSeconds: number | null;
}

interface LaunchdRuntime {
  runs: number | null;
  /** The raw text after `last exit code =`, e.g. `1` or `(never exited)`. */
  lastExitText: string | null;
  lastExitCode: number | null;
  state: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** One StartCalendarInterval dict as a 5-field cron expression; a missing key is a wildcard. */
function calendarToCron(entry: Record<string, unknown>): string {
  const field = (name: string, normalise?: (n: number) => number): string => {
    const value = entry[name];
    if (value === undefined) return "*";
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new Error(`${name} is not an integer`);
    }
    return String(normalise ? normalise(value) : value);
  };
  // launchd counts Sunday as 0 or 7.
  return [
    field("Minute"),
    field("Hour"),
    field("Day"),
    field("Month"),
    field("Weekday", (n) => (n === 7 ? 0 : n)),
  ].join(" ");
}

function launchdIntervalJob(
  agent: LaunchdAgent,
  plist: Record<string, unknown>,
  ctx: DoctorContext,
): Job {
  const job: Job = {
    source: "launchd",
    key: `scheduled:launchd:${agent.label}`,
    name: agent.label,
    intervalSec: null,
    derivation: "",
    callsClaude: referencesClaude(agent.args.join(" "), agent.args, ctx),
  };
  const candidates: Array<{ seconds: number; derivation: string }> = [];
  const startInterval = plist.StartInterval;
  if (typeof startInterval === "number" && startInterval > 0) {
    candidates.push({ seconds: startInterval, derivation: `StartInterval ${startInterval} s` });
  }
  const calendar = plist.StartCalendarInterval;
  if (calendar !== undefined) {
    const entries = Array.isArray(calendar) ? calendar : [calendar];
    try {
      const expressions = entries.map((entry) => {
        const record = asRecord(entry);
        if (!record) throw new Error("entry is not a dict");
        return calendarToCron(record);
      });
      const gap = minGapSeconds(
        expressions.map((e) => parseCronExpression(e)),
        ctx.now(),
      );
      const derivation = `StartCalendarInterval as cron ${expressions.map((e) => `"${e}"`).join(" + ")}`;
      if (gap === null) {
        job.unknownWhy = `${derivation} fires fewer than twice in ${GAP_SEARCH_DAYS} days`;
      } else {
        candidates.push({ seconds: gap, derivation });
      }
    } catch (error) {
      job.unknownWhy = `StartCalendarInterval could not be read: ${errorMessage(error)}`;
    }
  }
  if (candidates.length > 0) {
    const best = candidates.reduce((a, b) => (b.seconds < a.seconds ? b : a));
    job.intervalSec = best.seconds;
    job.derivation = best.derivation;
    delete job.unknownWhy;
  } else if (job.unknownWhy === undefined) {
    job.noTimer = `no StartInterval or StartCalendarInterval; KeepAlive ${agent.keepAlive}, RunAtLoad ${agent.runAtLoad}`;
  }
  return job;
}

/** `arguments = { ... }` block and `program = ...` of a `launchctl print`, for a job with no plist file. */
function parsePrintedProgram(stdout: string): { args: string[]; keepAlive: boolean } {
  const block = /^\s*arguments = \{\n([\s\S]*?)^\s*\}/m.exec(stdout);
  const args = block
    ? (block[1] as string)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    : [];
  const program = /^\s*program = (.+?)\s*$/m.exec(stdout)?.[1];
  const properties = /^\s*properties = (.+?)\s*$/m.exec(stdout)?.[1] ?? "";
  let finalArgs: string[];
  if (args.length > 0) {
    finalArgs = args;
  } else if (program) {
    finalArgs = [program];
  } else {
    finalArgs = [];
  }
  return {
    args: finalArgs,
    keepAlive: /keepalive/.test(properties),
  };
}

function parseLaunchctlPrint(stdout: string): LaunchdRuntime {
  const runs = /^\s*runs = (\d+)\s*$/m.exec(stdout);
  const exit = /^\s*last exit code = (.+?)\s*$/m.exec(stdout);
  const state = /^\s*state = (.+?)\s*$/m.exec(stdout);
  const exitText = exit?.[1] ?? null;
  const exitNumber = exitText !== null && /^-?\d+$/.test(exitText) ? Number(exitText) : null;
  return {
    runs: runs ? Number(runs[1]) : null,
    lastExitText: exitText,
    lastExitCode: exitNumber,
    state: state?.[1] ?? null,
  };
}

/**
 * Absolute-path arguments the job launches that no longer exist. An argument that directly
 * follows a `-flag` is an option value (an output path, say), not something launchd runs.
 */
function missingLaunchPaths(agent: LaunchdAgent, ctx: DoctorContext): string[] {
  const missing: string[] = [];
  agent.args.forEach((arg, index) => {
    if (!arg.startsWith("/") && !arg.startsWith("~/")) return;
    if (index > 0 && agent.args[index - 1].startsWith("-")) return;
    const expanded = expandPathLike(arg, ctx.home, ctx.env);
    if (!existsSync(expanded)) missing.push(expanded);
  });
  return missing;
}

function resolveUid(ctx: DoctorContext): string | null {
  const injected = ctx.env.__TOKEN_AUDIT_UID;
  if (injected !== undefined) return injected === "" ? null : injected;
  const uid = process.getuid?.();
  return uid === undefined ? null : String(uid);
}

function buildCrashFlags(
  agent: LaunchdAgent,
  runtime: LaunchdRuntime | null,
  missing: string[],
): {
  failing: boolean;
  looping: boolean;
  missingScript: boolean;
} {
  const failing = runtime !== null && runtime.lastExitCode !== null && runtime.lastExitCode !== 0;
  const looping = failing && runtime.runs !== null && runtime.runs >= CRASH_LOOP_RUNS;
  const missingScript = agent.keepAlive && missing.length > 0;
  return { failing, looping, missingScript };
}

function buildCrashEvidence(
  runtime: LaunchdRuntime | null,
  agent: LaunchdAgent,
  missing: string[],
): string {
  const parts: (string | null)[] = [
    runtime?.runs != null ? `runs = ${runtime.runs}` : "runs UNKNOWN",
    runtime?.lastExitText != null
      ? `last exit code = ${runtime.lastExitText}`
      : "last exit code UNKNOWN",
    runtime?.state != null ? `state = ${runtime.state}` : null,
    agent.keepAlive ? "KeepAlive" : null,
    missing.length > 0
      ? `missing path${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`
      : null,
    `plist ${agent.plistPath}`,
  ];
  return parts.filter((part): part is string => part !== null).join("; ");
}

function buildCrashFindingAndCost(
  agent: LaunchdAgent,
  runtime: LaunchdRuntime | null,
  severity: TokenSeverity,
  missingScript: boolean,
): { finding: string; cost: string } {
  const finding =
    severity === "RED"
      ? `launchd ${agent.label}: crash-looping${missingScript ? " (script missing)" : ""}`
      : `launchd ${agent.label}: last run exited ${runtime?.lastExitText}`;
  const throttle = agent.throttleSeconds ?? DEFAULT_THROTTLE_SECONDS;
  const restarts = Math.floor(DAY_SECONDS / throttle);
  const launches =
    runtime?.runs != null ? `${runtime.runs} launches so far` : "launch count UNKNOWN";
  const cost = agent.keepAlive
    ? `${launches}; at most ${restarts} restarts/day (86400 / ThrottleInterval ${throttle} s${agent.throttleSeconds === null ? ", the default" : ""}; a bound, not a measurement)`
    : launches;
  return { finding, cost };
}

function crashRow(
  agent: LaunchdAgent,
  runtime: LaunchdRuntime | null,
  missing: string[],
): TokenAuditRow | null {
  const { failing, looping, missingScript } = buildCrashFlags(agent, runtime, missing);
  if (!looping && !missingScript && !failing) return null;
  const severity: TokenSeverity = looping || missingScript ? "RED" : "AMBER";
  const evidence = buildCrashEvidence(runtime, agent, missing);
  const { finding, cost } = buildCrashFindingAndCost(agent, runtime, severity, missingScript);
  const metrics: Record<string, number> = {};
  if (runtime?.runs != null) metrics.runs = runtime.runs;
  if (runtime?.lastExitCode != null) metrics.lastExitCode = runtime.lastExitCode;
  return row(
    "scheduled",
    `scheduled:crashloop:${agent.label}`,
    severity,
    finding,
    evidence,
    cost,
    metrics,
  );
}

async function launchdJobs(ctx: DoctorContext, extraRows: TokenAuditRow[]): Promise<Job[]> {
  const dir = path.join(ctx.home, "Library", "LaunchAgents");
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => n.endsWith(".plist"))
      .sort();
  } catch {
    names = [];
  }
  const uid = resolveUid(ctx);
  const jobs: Job[] = [];
  const seenLabels = new Set<string>();
  for (const name of names) {
    const file = path.join(dir, name);
    const converted = await ctx.probes.exec("plutil", ["-convert", "json", "-o", "-", file], {
      timeoutMs: EXEC_TIMEOUT_MS,
    });
    let plist: Record<string, unknown> | null = null;
    if (converted !== null && converted.code === 0) {
      try {
        plist = asRecord(JSON.parse(converted.stdout));
      } catch {
        plist = null;
      }
    }
    if (plist === null) {
      jobs.push({
        source: "launchd",
        key: `scheduled:launchd:${name}`,
        name,
        intervalSec: null,
        derivation: file,
        unknownWhy: `plutil could not convert ${file} to JSON`,
        callsClaude: false,
      });
      continue;
    }
    const label =
      typeof plist.Label === "string" && plist.Label ? plist.Label : name.replace(/\.plist$/, "");
    const programArguments = Array.isArray(plist.ProgramArguments)
      ? plist.ProgramArguments.filter((a): a is string => typeof a === "string")
      : [];
    let args: string[];
    if (programArguments.length > 0) {
      args = programArguments;
    } else if (typeof plist.Program === "string") {
      args = [plist.Program];
    } else {
      args = [];
    }
    const keepAliveValue = plist.KeepAlive;
    const agent: LaunchdAgent = {
      label,
      plistPath: file,
      args,
      keepAlive: keepAliveValue === true || asRecord(keepAliveValue) !== null,
      runAtLoad: plist.RunAtLoad === true,
      throttleSeconds:
        typeof plist.ThrottleInterval === "number" && plist.ThrottleInterval > 0
          ? plist.ThrottleInterval
          : null,
    };
    jobs.push(launchdIntervalJob(agent, plist, ctx));

    let runtime: LaunchdRuntime | null = null;
    if (uid !== null) {
      const printed = await ctx.probes.exec("launchctl", ["print", `gui/${uid}/${label}`], {
        timeoutMs: EXEC_TIMEOUT_MS,
      });
      if (printed !== null && printed.code === 0) runtime = parseLaunchctlPrint(printed.stdout);
    }
    const crash = crashRow(agent, runtime, missingLaunchPaths(agent, ctx));
    if (crash) extraRows.push(crash);
    seenLabels.add(label);
  }
  await loadedWithoutPlist(ctx, { uid, seenLabels, extraRows });
  return jobs;
}

/**
 * Jobs launchd still holds whose plist is gone from `~/Library/LaunchAgents`: the case where a
 * script path disappeared and the job kept respawning (one ran 189 times before anyone looked).
 * Apple's own labels and app-launched ones are skipped; only a non-zero last exit is followed up.
 */
async function loadedWithoutPlist(
  ctx: DoctorContext,
  input: { uid: string | null; seenLabels: Set<string>; extraRows: TokenAuditRow[] },
): Promise<void> {
  if (input.uid === null) return;
  const listed = await ctx.probes.exec("launchctl", ["list"], { timeoutMs: EXEC_TIMEOUT_MS });
  if (listed === null || listed.code !== 0) return;
  for (const line of listed.stdout.split("\n")) {
    const match = /^(\S+)\s+(-?\d+)\s+(\S+)$/.exec(line.trim());
    if (!match) continue;
    const [, , status, label] = match as unknown as [string, string, string, string];
    if (Number(status) === 0 || input.seenLabels.has(label)) continue;
    if (/^(com\.apple\.|application\.|com\.openssh\.)/.test(label)) continue;
    const printed = await ctx.probes.exec("launchctl", ["print", `gui/${input.uid}/${label}`], {
      timeoutMs: EXEC_TIMEOUT_MS,
    });
    if (printed === null || printed.code !== 0) continue;
    const program = parsePrintedProgram(printed.stdout);
    const agent: LaunchdAgent = {
      label,
      plistPath: "none in ~/Library/LaunchAgents (loaded, file gone)",
      args: program.args,
      keepAlive: program.keepAlive,
      runAtLoad: false,
      throttleSeconds: null,
    };
    const crash = crashRow(
      agent,
      parseLaunchctlPrint(printed.stdout),
      missingLaunchPaths(agent, ctx),
    );
    if (crash) input.extraRows.push(crash);
  }
}

// ---- rows ----------------------------------------------------------------------------------------

function seconds(ms: number): number {
  return Math.round(ms / 1000);
}

function jobRow(job: Job, cache: CacheLifetimeMeasurement | null): TokenAuditRow {
  const finding = (tail: string) => `${job.source} ${job.name}: ${tail}`;
  if (job.unknownWhy !== undefined) {
    return row(
      "scheduled",
      job.key,
      "UNKNOWN",
      finding("interval unknown"),
      `UNKNOWN: ${job.unknownWhy}`,
      "UNKNOWN",
    );
  }
  if (job.noTimer !== undefined || job.intervalSec === null) {
    return row(
      "scheduled",
      job.key,
      "GREEN",
      finding("no timer"),
      job.noTimer ?? "no interval",
      "none: nothing on a timer to compare with the cache lifetime",
    );
  }
  const interval = job.intervalSec;
  const lifetimeSec = cache?.lifetimeMs != null ? seconds(cache.lifetimeMs) : null;
  const lifetimeText =
    lifetimeSec === null
      ? "cache lifetime UNKNOWN"
      : `cache lifetime ${lifetimeSec} s (1h tokens ${cache?.oneHourTokens}, 5m tokens ${cache?.fiveMinTokens})`;
  const evidence = [
    `interval ${interval} s (${job.derivation})`,
    lifetimeText,
    job.callsClaude ? "references claude" : "does not reference claude",
  ].join("; ");
  const metrics: Record<string, number> = { intervalSec: interval };
  if (lifetimeSec !== null) metrics.cacheLifetimeSec = lifetimeSec;
  const title = finding(`every ${humanizeSeconds(interval)}`);
  if (!job.callsClaude) {
    return row(
      "scheduled",
      job.key,
      "GREEN",
      title,
      evidence,
      "none: does not call claude",
      metrics,
    );
  }
  if (lifetimeSec === null) {
    return row("scheduled", job.key, "UNKNOWN", title, evidence, "UNKNOWN", metrics);
  }
  if (interval > lifetimeSec) {
    const perDay = Math.round((DAY_SECONDS / interval) * 10) / 10;
    return row(
      "scheduled",
      job.key,
      "AMBER",
      title,
      evidence,
      `each run re-reads the prefix cold: ${perDay} runs/day, next run ${interval} s after the last, cache lasts ${lifetimeSec} s`,
      metrics,
    );
  }
  return row(
    "scheduled",
    job.key,
    "GREEN",
    title,
    evidence,
    "none: next run arrives inside the cache lifetime",
    metrics,
  );
}

async function loadCacheLifetime(
  ctx: DoctorContext,
  deadline: number,
  options: ScheduledCheckOptions,
): Promise<CacheLifetimeMeasurement | null> {
  try {
    if (options.measureCacheLifetime) return await options.measureCacheLifetime(ctx, deadline);
    const module = (await import("./cache.js")) as unknown as {
      measureCacheLifetime: NonNullable<ScheduledCheckOptions["measureCacheLifetime"]>;
    };
    return await module.measureCacheLifetime(ctx, deadline);
  } catch {
    return null;
  }
}

export function createScheduledCheck(options: ScheduledCheckOptions = {}): TokenAuditCheck {
  return {
    id: "tokens.scheduled",
    item: "scheduled",
    timeoutMs: 60_000,
    async measure(ctx, deadline) {
      const extraRows: TokenAuditRow[] = [];
      const paseo = paseoJobs(ctx);
      const cron = ctx.platform === "win32" ? [] : await cronJobs(ctx, extraRows);
      let launchd: Job[] = [];
      if (ctx.platform === "darwin") {
        launchd = await launchdJobs(ctx, extraRows);
      } else {
        extraRows.push(
          row(
            "scheduled",
            "scheduled:launchd",
            "UNKNOWN",
            "launchd: not probed on this platform",
            `UNKNOWN: launchd probe skipped because platform is ${ctx.platform}${ctx.platform === "win32" ? "; Task Scheduler not probed" : ""}`,
            "UNKNOWN",
          ),
        );
      }
      const jobs = [...paseo, ...cron, ...launchd];
      const cache = jobs.length > 0 ? await loadCacheLifetime(ctx, deadline, options) : null;
      const jobRows = jobs.map((job) => jobRow(job, cache));
      const ranked = [...jobRows, ...extraRows]
        .map((r, index) => ({ r, index }))
        .sort(
          (a, b) => severityRank(a.r.severity) - severityRank(b.r.severity) || a.index - b.index,
        )
        .map(({ r }) => r);
      const kept = ranked.slice(0, MAX_JOB_ROWS);
      const omitted = ranked.length - kept.length;

      const exceed = jobRows.filter((r) => r.severity === "AMBER").length;
      const crashLooping = extraRows.filter(
        (r) => r.key.startsWith("scheduled:crashloop:") && r.severity === "RED",
      ).length;
      const failing = extraRows.filter(
        (r) => r.key.startsWith("scheduled:crashloop:") && r.severity === "AMBER",
      ).length;
      const count = (source: Source) => jobs.filter((j) => j.source === source).length;
      let summarySeverity: TokenSeverity;
      if (crashLooping > 0) {
        summarySeverity = "RED";
      } else if (exceed + failing > 0) {
        summarySeverity = "AMBER";
      } else {
        summarySeverity = "GREEN";
      }
      const lifetimeText =
        cache?.lifetimeMs != null
          ? `cache lifetime ${seconds(cache.lifetimeMs)} s`
          : "cache lifetime UNKNOWN";
      const summary = row(
        "scheduled",
        "scheduled:summary",
        summarySeverity,
        `scheduled work: ${jobs.length} jobs, ${exceed} exceed the cache lifetime, ${crashLooping} crash-looping`,
        `paseo ${count("paseo")}, cron ${count("cron")}, launchd ${count("launchd")}; ${exceed} exceed the cache lifetime; ${crashLooping} crash-looping; ${failing} failing with under ${CRASH_LOOP_RUNS} runs; ${lifetimeText}; ${omitted} omitted (${MAX_JOB_ROWS}-row cap)`,
        summarySeverity === "GREEN" ? "none" : "see the flagged rows",
        { jobs: jobs.length, exceedCacheLifetime: exceed, crashLooping, omitted },
      );
      return [...kept, summary];
    },
  };
}

export const scheduledCheck: TokenAuditCheck = createScheduledCheck();
