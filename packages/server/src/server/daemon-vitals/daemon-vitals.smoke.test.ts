import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";
import type { PushNotificationSender } from "../push/index.js";
import { createPaseoDaemon } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { readDaemonVitals } from "./vitals-file.js";

/**
 * An isolated in-process daemon (never the one on 6767) with the vitals on, and a forced stall:
 * the test blocks the shared event loop, which is the daemon's own. The thresholds are shrunk so
 * the stall is seconds, not the 30 s the acceptance case names; the mechanism is identical.
 */

const FAST_VITALS = {
  enabled: true,
  tickMs: 50,
  slowStallMs: 300,
  wedgeMs: 1_000,
  suspendMs: 1_000,
} as const;

function captureLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const logger = pino(
    { level: "info" },
    {
      write(chunk: string) {
        lines.push(JSON.parse(chunk) as Record<string, unknown>);
      },
    },
  );
  return { logger, lines };
}

function captureSender() {
  const sent: Array<{ title: string; body: string; data?: Record<string, unknown> }> = [];
  const sender: PushNotificationSender = {
    async send(payload) {
      sent.push(payload as (typeof sent)[number]);
    },
  };
  return { sender, sent };
}

function blockEventLoop(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // The stall.
  }
}

function hasLog(lines: Array<Record<string, unknown>>, msg: string): boolean {
  return lines.some((line) => line.msg === msg);
}

async function readTextOrEmpty(filePath: string): Promise<string> {
  return readFile(filePath, "utf8").catch(() => "");
}

async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not reached");
}

describe("daemon vitals in an isolated daemon", () => {
  test("ships off: nothing is started and nothing is written", async () => {
    const { logger, lines } = captureLogger();
    const handle = await createTestPaseoDaemon({ logger });
    try {
      const mode = lines.find(
        (line) => line.msg === "Monitor mode" && line.monitor === "daemonVitals",
      );
      expect(mode).toMatchObject({ enabled: false, dryRun: true });
      await expect(stat(path.join(handle.paseoHome, "diagnostics"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await handle.close();
    }
  });

  test("a forced stall is recorded, and reported by push once the loop recovers", async () => {
    const { logger, lines } = captureLogger();
    const { sender, sent } = captureSender();
    const handle = await createTestPaseoDaemon({
      logger,
      pushNotificationSender: sender,
      daemonVitals: { ...FAST_VITALS, dryRun: false },
    });
    try {
      // Let the watchdog and the first ticks settle.
      await new Promise((resolve) => setTimeout(resolve, 500));
      blockEventLoop(2_000);

      await eventually(() => sent.length > 0);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.data).toMatchObject({ reason: "daemon_event_loop_wedged" });
      expect(sent[0]?.body).toMatch(/wedged for [12]s/);

      const wedgeLog = lines.find((line) => line.msg === "Event loop was wedged and has recovered");
      // `cause` is a CPU-share hint and this machine is shared, so it is not asserted here.
      expect(wedgeLog).toMatchObject({ dryRun: false });
      expect(lines.some((line) => String(line.msg).includes("suspended"))).toBe(false);

      // The wedge is in the slow-op timeline, so it can be lined up with what else was slow.
      const slowOpsPath = path.join(handle.paseoHome, "diagnostics", "slow-ops.jsonl");
      await eventually(async () => (await readTextOrEmpty(slowOpsPath)).includes("wedge"));
      const records = (await readFile(slowOpsPath, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { site: string; durationMs: number });
      expect(
        records.find((record) => record.site === "event-loop:wedge")?.durationMs,
      ).toBeGreaterThan(1_500);

      // And the heartbeat file, which `paseo daemon status` reads, remembers it.
      await eventually(() => {
        const read = readDaemonVitals(handle.paseoHome);
        return read.status === "ok" && (read.file.summary?.counts.wedges ?? 0) === 1;
      });
    } finally {
      await handle.close();
    }
  });

  test("a dry run logs what it would push and pushes nothing", async () => {
    const { logger, lines } = captureLogger();
    const { sender, sent } = captureSender();
    const handle = await createTestPaseoDaemon({
      logger,
      pushNotificationSender: sender,
      daemonVitals: { ...FAST_VITALS },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      blockEventLoop(2_000);

      await eventually(() => hasLog(lines, "Daemon vitals dry run: would push"));
      expect(sent).toHaveLength(0);
      const mode = lines.find(
        (line) => line.msg === "Monitor mode" && line.monitor === "daemonVitals",
      );
      expect(mode).toMatchObject({ enabled: true, dryRun: true });
    } finally {
      await handle.close();
    }
  });

  test("the heartbeat file says stopped after a clean daemon stop", async () => {
    const { logger } = captureLogger();
    const handle = await createTestPaseoDaemon({
      logger,
      daemonVitals: { ...FAST_VITALS },
      cleanup: false,
    });
    const paseoHome = handle.paseoHome;
    await eventually(() => readDaemonVitals(paseoHome).status === "ok");
    await handle.close();

    const read = readDaemonVitals(paseoHome);
    await rm(path.dirname(paseoHome), { recursive: true, force: true });
    expect(read.status === "ok" && read.file.stoppedAt).toBeTruthy();
  });

  // Every agents.* section is off unless config.json turns it on, so a section that never reaches
  // its monitor looks the same as one configured off. This goes the whole way a real daemon does.
  test("agents.daemonVitals in config.json reaches the running detector", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-vitals-config-"));
    const paseoHome = path.join(root, ".paseo");
    await mkdir(paseoHome, { recursive: true });
    const persisted = {
      version: 1 as const,
      daemon: { listen: "127.0.0.1:0", relay: { enabled: false } },
      agents: { daemonVitals: { ...FAST_VITALS, dryRun: true } },
    };
    await writeFile(path.join(paseoHome, "config.json"), JSON.stringify(persisted), "utf-8");
    const config = loadConfig(paseoHome, { env: {} });
    config.agentClients = createTestAgentClients();
    config.agentStoragePath = path.join(paseoHome, "agents");
    config.isDev = true;
    const { logger, lines } = captureLogger();
    const daemon = await createPaseoDaemon(config, logger);
    try {
      expect(config.daemonVitals).toEqual(persisted.agents.daemonVitals);
      await daemon.start();
      const mode = lines.find(
        (line) => line.msg === "Monitor mode" && line.monitor === "daemonVitals",
      );
      expect(mode).toMatchObject({ enabled: true, dryRun: true });
      await eventually(() => readDaemonVitals(paseoHome).status === "ok");
    } finally {
      await daemon.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});
