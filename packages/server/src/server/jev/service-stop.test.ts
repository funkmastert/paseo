import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

import pino from "pino";
import { afterEach, expect, test, vi } from "vitest";

import { JEV_STOP_TIMEOUT_MS } from "../daemon-vitals/shutdown-budget.js";
import { resolveJevConfig } from "./config.js";
import { createFakeJevTransport } from "./fake.js";
import { createJevService } from "./service.js";

/** A stuck disk, for the decisions file only: every other JEV write goes through for real. */
const decisionsWrite = vi.hoisted(() => ({ entered: false }));
vi.mock("../atomic-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../atomic-file.js")>();
  return {
    ...actual,
    writeFileAtomic: (...args: Parameters<typeof actual.writeFileAtomic>) => {
      if (!args[0].endsWith("decisions.json")) return actual.writeFileAtomic(...args);
      decisionsWrite.entered = true;
      return new Promise<void>(() => {});
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a hung decisions write holds stop() no longer than JEV_STOP_TIMEOUT_MS", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jev-service-stop-"));
  roots.push(root);
  const home = path.join(root, "home");
  const paseoHome = path.join(root, "paseo-home");
  mkdirSync(home, { recursive: true });
  mkdirSync(paseoHome, { recursive: true });
  let logText = "";
  const logger = pino(
    { level: "warn" },
    new Writable({
      write(chunk, _encoding, callback) {
        logText += chunk.toString();
        callback();
      },
    }),
  );
  const config = resolveJevConfig({}, { homeDir: home });
  const service = createJevService({
    paseoHome,
    logger,
    homeDir: home,
    platform: "darwin",
    env: {},
    capturedKey: { present: false, value: () => null },
    transport: createFakeJevTransport(),
    configReader: { read: () => ({ ok: true, config }) },
  });
  await service.start();
  service.decisions.record({
    agentId: "agent-1",
    callId: "call-1",
    feature: "stallJudgment",
    question: "Is the agent stuck?",
    verdict: "waiting_on_human (0.8)",
    confidence: 0.8,
    action: "nudged with a person-first handoff",
    applied: true,
  });

  const startedAt = performance.now();
  const outcome = await Promise.race([
    service.stop().then(() => "stopped" as const),
    sleep(JEV_STOP_TIMEOUT_MS + 3_000).then(() => "still hung" as const),
  ]);
  const elapsedMs = performance.now() - startedAt;

  expect(decisionsWrite.entered).toBe(true);
  expect(outcome).toBe("stopped");
  // It waited for the write until the bound, rather than skipping it.
  expect(elapsedMs).toBeGreaterThanOrEqual(JEV_STOP_TIMEOUT_MS - 50);
  expect(logText).toContain("jev: stop timed out");
}, 10_000);
