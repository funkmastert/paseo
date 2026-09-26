import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PushPayload, PushSendMeta } from "../push/index.js";
import type { RemediationObservation } from "../remediation/contract.js";
import type { DoctorContext } from "../session/doctor/context.js";
import { makeContext, makeFixture } from "../session/doctor/test-support.js";
import { row, type TokenAuditReport, type TokenAuditRow } from "../session/doctor/tokens/types.js";
import { resolveTokenAuditConfig } from "./config.js";
import { diffReports } from "./diff.js";
import { TokenAuditReportStore } from "./report-store.js";
import { TokenAuditJob } from "./token-audit-job.js";

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-09-24T12:00:00.000Z");

function report(rows: TokenAuditRow[], at = "2026-09-24T12:00:00.000Z"): TokenAuditReport {
  return { version: 1, generatedAt: at, source: "job", rows };
}

const memoryRed = row("memory", "memory:total:/p", "RED", "Total memory", "14.7k", "14700", {
  "memory.totalTokens": 14_700,
});
const cache = (read: number, creation: number, median: number) =>
  row("cache", "cache:fleet-7d", "GREEN", "Fleet", "x", "y", {
    "cache.readShare": read,
    "cache.creationShare": creation,
    "cache.lastTurnContextMedian": median,
  });

describe("diffReports", () => {
  it("escalates every RED on the first report, and only a new RED after that", () => {
    const first = diffReports(null, report([memoryRed]));
    expect(first.escalate).toBe(true);
    expect(first.reasons).toEqual(["new RED: Total memory"]);

    const same = diffReports(report([memoryRed]), report([memoryRed]));
    expect(same.escalate).toBe(false);

    const other = row("tools", "tools:deferral", "RED", "Deferral off", "0", "all");
    const added = diffReports(report([memoryRed]), report([memoryRed, other]));
    expect(added.newRed.map((r) => r.key)).toEqual(["tools:deferral"]);
  });

  it("counts a severity that got worse as a crossed threshold, and ignores UNKNOWN moves", () => {
    const green = row("hooks", "hooks:x", "GREEN", "h", "1", "c");
    const amber = row("hooks", "hooks:x", "AMBER", "h", "0", "c");
    const unknown = row("hooks", "hooks:x", "UNKNOWN", "h", "UNKNOWN: x", "UNKNOWN");
    expect(diffReports(report([green]), report([amber])).crossed).toHaveLength(1);
    expect(diffReports(report([amber]), report([green])).escalate).toBe(false);
    expect(diffReports(report([green]), report([unknown])).escalate).toBe(false);
    expect(diffReports(report([unknown]), report([amber])).escalate).toBe(false);
    const red: TokenAuditRow = { ...amber, severity: "RED" };
    expect(diffReports(report([amber]), report([red])).newRed).toHaveLength(1);
  });

  it("escalates on a material rise in cache-read share, write share or median context", () => {
    const base = report([cache(90, 5, 60_000)]);
    expect(diffReports(base, report([cache(94, 5, 60_000)])).escalate).toBe(false);
    const read = diffReports(base, report([cache(95, 5, 60_000)]));
    expect(read.risen.map((r) => r.metric)).toEqual(["cache.readShare"]);
    expect(read.reasons).toEqual(["cache-read share rose from 90% to 95%"]);
    expect(diffReports(base, report([cache(90, 10, 60_000)])).risen[0]?.metric).toBe(
      "cache.creationShare",
    );
    expect(diffReports(base, report([cache(90, 5, 72_000)])).risen[0]?.metric).toBe(
      "cache.lastTurnContextMedian",
    );
    expect(diffReports(base, report([cache(90, 5, 71_000)])).escalate).toBe(false);
    // A falling number is not a regression here.
    expect(diffReports(base, report([cache(80, 2, 30_000)])).escalate).toBe(false);
  });

  it("does not call a small base growing a regression", () => {
    const small = report([
      row("memory", "memory:total:/p", "GREEN", "t", "e", "c", { "memory.totalTokens": 800 }),
    ]);
    const doubled = report([
      row("memory", "memory:total:/p", "GREEN", "t", "e", "c", { "memory.totalTokens": 1600 }),
    ]);
    expect(diffReports(small, doubled).escalate).toBe(false);
  });
});

describe("resolveTokenAuditConfig", () => {
  it("defaults to weekly, on, keeping 8, with a small escalation agent", () => {
    expect(resolveTokenAuditConfig(undefined)).toEqual({
      enabled: true,
      intervalDays: 7,
      keep: 8,
      escalation: { enabled: true, budgetTokens: 150_000, timeoutMinutes: 10 },
    });
    expect(
      resolveTokenAuditConfig({
        enabled: false,
        intervalDays: 14,
        keep: 3,
        escalation: { enabled: false, budgetTokens: 5 },
      }),
    ).toEqual({
      enabled: false,
      intervalDays: 14,
      keep: 3,
      escalation: { enabled: false, budgetTokens: 5, timeoutMinutes: 10 },
    });
    expect(resolveTokenAuditConfig({ intervalDays: -1, keep: "x" }).intervalDays).toBe(7);
  });
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "token-audit-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("TokenAuditReportStore", () => {
  it("saves json and markdown, lists newest first, keeps the newest N and skips a corrupt file", async () => {
    const store = new TokenAuditReportStore(path.join(dir, "token-audit"));
    for (const day of [20, 21, 22, 23]) {
      await store.save(report([memoryRed], `2026-09-${day}T12:00:00.000Z`));
    }
    const names = await readdir(path.join(dir, "token-audit"));
    expect(names).toContain("report-20260923T120000Z.md");
    const md = await readFile(path.join(dir, "token-audit", "report-20260923T120000Z.md"), "utf8");
    expect(md).toContain("| FINDING | SEVERITY | EVIDENCE | COST |");
    await store.prune(2);
    expect((await store.list()).map((r) => r.generatedAt)).toEqual([
      "2026-09-23T12:00:00.000Z",
      "2026-09-22T12:00:00.000Z",
    ]);
    expect(existsSync(path.join(dir, "token-audit", "report-20260920T120000Z.md"))).toBe(false);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, "token-audit", "report-20260924T120000Z.json"), "{not json");
    expect((await store.latest())?.generatedAt).toBe("2026-09-23T12:00:00.000Z");
  });
});

describe("TokenAuditJob", () => {
  let nowMs: number;
  let observed: RemediationObservation[];
  let pushes: Array<{ payload: PushPayload; meta: PushSendMeta | undefined }>;
  let rows: TokenAuditRow[];
  let config: ReturnType<typeof resolveTokenAuditConfig>;
  let ctx: DoctorContext;

  beforeEach(() => {
    nowMs = START;
    observed = [];
    pushes = [];
    rows = [memoryRed, row("hooks", "hooks:x", "GREEN", "Hooks fine", "1", "c")];
    config = resolveTokenAuditConfig(undefined);
    ctx = makeContext(makeFixture());
  });

  function job(): TokenAuditJob {
    return new TokenAuditJob({
      paseoHome: dir,
      buildContext: () => ctx,
      readConfig: () => config,
      sink: { observe: async (o) => void observed.push(o) },
      getPushNotificationSender: () => ({
        send: async (payload, meta) => void pushes.push({ payload, meta }),
      }),
      serverId: "srv",
      logger: pino({ level: "silent" }),
      now: () => nowMs,
      runAudit: async () => rows,
    });
  }

  it("hands a new RED to the ladder as one small mechanical advisory agent, and pushes nothing itself", async () => {
    const outcome = await job().runOnce();
    expect(outcome.kind).toBe("escalated");
    expect(pushes).toEqual([]);
    expect(observed).toHaveLength(1);
    const o = observed[0]!;
    expect(o).toMatchObject({
      kind: "token-audit",
      active: true,
      remedy: "none",
      level: "notice",
      escalation: {
        taskClass: "mechanical",
        budgetTokens: 150_000,
        timeoutMinutes: 10,
        advice: true,
      },
    });
    expect(o.key).toBe("token-audit:report-20260924T120000Z");
    expect(o.title).toBe("Token audit: 1 new RED, 0 regressed");
    expect(o.summary).toContain("Report: ");
    expect(o.summary).toContain("report-20260924T120000Z.md");
    expect(o.evidence).toContain("- new RED: Total memory");
    expect(o.evidence).toContain("| MEMORY: Total memory | RED |");
    expect(o.evidence).not.toContain("Hooks fine");
    expect(existsSync(path.join(dir, "token-audit", "report-20260924T120000Z.md"))).toBe(true);
  });

  it("records a quiet run at level record, and closes the previous run's episode", async () => {
    const j = job();
    await j.runOnce();
    nowMs += 7 * DAY;
    observed.length = 0;
    const outcome = await j.runOnce();
    expect(outcome.kind).toBe("recorded");
    expect(observed).toEqual([
      expect.objectContaining({
        key: "token-audit:report-20260924T120000Z",
        active: false,
        kind: "token-audit",
      }),
    ]);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.meta).toEqual({ level: "record" });
    expect(pushes[0]?.payload.title).toBe("Token audit: 1 RED, 0 AMBER, nothing new");
    expect(pushes[0]?.payload.body).toContain("report-20261001T120000Z.md");
  });

  it("escalates a regression the week it happens, with the reason in the evidence", async () => {
    rows = [cache(90, 5, 60_000)];
    const j = job();
    await j.runOnce();
    expect(observed).toHaveLength(0);
    nowMs += 7 * DAY;
    rows = [cache(96, 5, 60_000)];
    await j.runOnce();
    expect(observed.at(-1)?.evidence).toContain("- cache-read share rose from 90% to 96%");
    expect(observed.at(-1)?.title).toBe("Token audit: 0 new RED, 1 regressed");
  });

  it("only runs when the last report is older than intervalDays, and never when disabled", async () => {
    const j = job();
    expect(await j.checkDue()).not.toBeNull();
    nowMs += 6 * DAY;
    expect(await j.checkDue()).toBeNull();
    nowMs += 1 * DAY;
    expect(await j.checkDue()).not.toBeNull();
    config = resolveTokenAuditConfig({ intervalDays: 30 });
    nowMs += 8 * DAY;
    expect(await j.checkDue()).toBeNull();
    config = resolveTokenAuditConfig({ enabled: false });
    nowMs += 60 * DAY;
    expect(await j.checkDue()).toBeNull();
  });

  it("pushes the headline at notice itself when the escalation agent is turned off", async () => {
    config = resolveTokenAuditConfig({ escalation: { enabled: false } });
    const outcome = await job().runOnce();
    expect(outcome).toMatchObject({ kind: "escalated", viaAgent: false });
    expect(observed).toHaveLength(0);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.meta?.level).toBe("notice");
    expect(pushes[0]?.payload.body).toContain("Report: ");
  });

  it("keeps only the newest N reports", async () => {
    config = resolveTokenAuditConfig({ keep: 2 });
    const j = job();
    for (let i = 0; i < 4; i += 1) {
      await j.runOnce();
      nowMs += 7 * DAY;
    }
    const names = (await readdir(path.join(dir, "token-audit"))).filter((n) => n.endsWith(".json"));
    expect(names).toHaveLength(2);
  });
});
