import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import type { RemedyAttempt } from "../remediation/contract.js";
import type { SystemMemorySample } from "./process-sampler.js";
import type { SaturationEvidence } from "./saturation-evidence.js";
import type { SystemLoadReading, SystemLoadSample } from "./system-load.js";

/**
 * The saturation incident ledger: `$PASEO_HOME/resource-monitor/incidents.jsonl`, one JSON record
 * per line. It exists so the evidence survives the reboot a saturated machine usually ends in,
 * which is why every record is its own open, write, fdatasync and close rather than a buffered
 * stream. Records are a few per incident, so that costs nothing. See docs/resource-monitor.md.
 */

export const SATURATION_LEDGER_DIR = "resource-monitor";
export const SATURATION_LEDGER_FILE = "incidents.jsonl";
const PREVIOUS_LEDGER_FILE = "incidents.1.jsonl";
const DEFAULT_MAX_BYTES = 1024 * 1024;

export type SaturationLedgerEvent = "open" | "ongoing" | "clear";

export interface SaturationLedgerRecord {
  version: 1;
  at: string;
  event: SaturationLedgerEvent;
  /** When the incident opened; every record of one incident carries the same value. */
  openedAt: string;
  peakLoad1: number;
  load: SystemLoadReading | null;
  memory: {
    freeBytes: number;
    totalBytes: number;
    availableBytes: number | null;
    swapUsedBytes: number | null;
    swapTotalBytes: number | null;
  };
  evidence: SaturationEvidence;
  /** What the daemon did about it in this sweep. Absent on records written before it acted. */
  actions?: RemedyAttempt[];
}

export function buildSaturationLedgerRecord(input: {
  event: SaturationLedgerEvent;
  atMs: number;
  openedAtMs: number;
  peakLoad1: number;
  systemLoad: SystemLoadSample;
  systemMemory: SystemMemorySample | undefined;
  evidence: SaturationEvidence;
  actions?: readonly RemedyAttempt[];
}): SaturationLedgerRecord {
  return {
    version: 1,
    at: new Date(input.atMs).toISOString(),
    event: input.event,
    openedAt: new Date(input.openedAtMs).toISOString(),
    peakLoad1: input.peakLoad1,
    load: input.systemLoad.load ?? null,
    memory: {
      freeBytes: input.systemLoad.freeMemoryBytes,
      totalBytes: input.systemLoad.totalMemoryBytes,
      availableBytes: input.systemMemory?.availableBytes ?? null,
      swapUsedBytes: input.systemMemory?.swapUsedBytes ?? null,
      swapTotalBytes: input.systemMemory?.swapTotalBytes ?? null,
    },
    evidence: input.evidence,
    ...(input.actions && input.actions.length > 0 ? { actions: [...input.actions] } : {}),
  };
}

export function saturationLedgerPath(paseoHome: string): string {
  return path.join(paseoHome, SATURATION_LEDGER_DIR, SATURATION_LEDGER_FILE);
}

export interface SaturationLedger {
  append(record: SaturationLedgerRecord): Promise<void>;
}

async function syncDirectory(dir: string): Promise<void> {
  // Makes a new or renamed file's directory entry durable too. Windows cannot open a directory
  // for this, and NTFS journals the entry anyway.
  if (process.platform === "win32") return;
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fileSize(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).size;
  } catch {
    return undefined;
  }
}

// A power cut can leave the last line torn, with no newline. Appending straight after it would glue
// the next record onto that line and lose it too.
async function endsMidLine(file: string, size: number): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    await handle.close();
  }
}

export function createSaturationLedger(options: {
  paseoHome: string;
  logger: { warn: (obj: object, msg?: string) => void };
  maxBytes?: number;
}): SaturationLedger {
  const file = saturationLedgerPath(options.paseoHome);
  const dir = path.dirname(file);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let failing = false;
  return {
    async append(record) {
      const line = `${JSON.stringify(record)}\n`;
      try {
        await mkdir(dir, { recursive: true });
        const size = await fileSize(file);
        const rotate = size !== undefined && size > 0 && size + Buffer.byteLength(line) > maxBytes;
        if (rotate) await rename(file, path.join(dir, PREVIOUS_LEDGER_FILE));
        const torn = !rotate && size !== undefined && size > 0 && (await endsMidLine(file, size));
        const handle = await open(file, "a");
        try {
          await handle.write(torn ? `\n${line}` : line);
          await handle.datasync();
        } finally {
          await handle.close();
        }
        if (rotate || size === undefined) await syncDirectory(dir);
        failing = false;
      } catch (error) {
        // The ledger is evidence, not a leg: a full disk must not cost the sweep. Said once per
        // run of failures.
        if (!failing) {
          failing = true;
          options.logger.warn({ err: error, file }, "Failed to write the saturation ledger");
        }
      }
    },
  };
}

export interface SaturationIncidentSummary {
  openedAt: string;
  lastAt: string;
  /** Null while the incident is still open, or when the machine went down before it cleared. */
  clearedAt: string | null;
  durationMs: number;
  peakLoad1: number;
  /** The record written nearest the peak: its load, cause and process trees. */
  peak: SaturationLedgerRecord;
}

function parseRecords(content: string): SaturationLedgerRecord[] {
  const records: SaturationLedgerRecord[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<SaturationLedgerRecord>;
      // A power cut can leave a torn last line; anything without the core fields is skipped.
      if (
        parsed.version === 1 &&
        typeof parsed.openedAt === "string" &&
        typeof parsed.at === "string"
      ) {
        records.push(parsed as SaturationLedgerRecord);
      }
    } catch {
      // Torn or foreign line.
    }
  }
  return records;
}

async function readLedgerFile(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

/** The most recent incident whose last record is within `windowMs` of `nowMs`, or undefined. */
export async function readLatestSaturationIncident(input: {
  paseoHome: string;
  nowMs: number;
  windowMs: number;
}): Promise<SaturationIncidentSummary | undefined> {
  const dir = path.join(input.paseoHome, SATURATION_LEDGER_DIR);
  const contents = await Promise.all([
    readLedgerFile(path.join(dir, PREVIOUS_LEDGER_FILE)),
    readLedgerFile(path.join(dir, SATURATION_LEDGER_FILE)),
  ]);
  const records = contents.flatMap(parseRecords);
  const latestOpenedAt = records
    .map((record) => record.openedAt)
    .reduce<string | undefined>(
      (latest, at) => (latest === undefined || at > latest ? at : latest),
      undefined,
    );
  if (latestOpenedAt === undefined) return undefined;

  const incident = records
    .filter((record) => record.openedAt === latestOpenedAt)
    .sort((a, b) => a.at.localeCompare(b.at));
  const last = incident[incident.length - 1];
  if (!last || input.nowMs - Date.parse(last.at) > input.windowMs) return undefined;
  const peak = incident.reduce((best, record) =>
    (record.load?.load1 ?? 0) > (best.load?.load1 ?? 0) ? record : best,
  );
  return {
    openedAt: latestOpenedAt,
    lastAt: last.at,
    clearedAt: last.event === "clear" ? last.at : null,
    durationMs: Date.parse(last.at) - Date.parse(latestOpenedAt),
    peakLoad1: Math.max(...incident.map((record) => record.peakLoad1)),
    peak,
  };
}
