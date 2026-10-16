import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  deriveVitalsVerdict,
  readDaemonVitals,
  type DaemonVitalsFile,
  type VitalsVerdict,
} from "./vitals-file.js";

/**
 * The monitor runs in a real child process, and the test does to that process what really
 * happens to the daemon: it blocks the main thread, and it suspends the whole process.
 * Thresholds are shrunk so this takes seconds; the classifier's logic is the same and is
 * covered exhaustively, without threads, in stall-tracker.test.ts.
 */

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "test-fixtures",
  "vitals-child.ts",
);

interface ChildMessage {
  type: string;
  level?: string;
  msg?: string;
  blockedMs?: number;
  suspendedMs?: number;
  cpuRatio?: number;
  cause?: string;
  snapshot?: { counts: { wedges: number; stalls: number; suspensions: number } };
  episode?: { blockedMs: number; cause: string };
}

class Child {
  readonly messages: ChildMessage[] = [];
  private readonly process: ChildProcess;

  constructor(paseoHome: string) {
    this.process = fork(FIXTURE, [paseoHome], { execArgv: ["--import", "tsx"], silent: true });
    this.process.on("message", (message) => this.messages.push(message as ChildMessage));
  }

  get pid(): number {
    if (this.process.pid === undefined) throw new Error("child did not start");
    return this.process.pid;
  }

  send(message: object): void {
    this.process.send(message);
  }

  async waitFor(predicate: (message: ChildMessage) => boolean, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.messages.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for a child message; saw ${JSON.stringify(this.messages)}`);
  }

  async snapshot() {
    const before = this.messages.length;
    this.send({ type: "snapshot" });
    await this.waitFor(
      (message) => message.type === "snapshot" && this.messages.indexOf(message) >= before,
    );
    const found = this.messages.findLast((message) => message.type === "snapshot");
    if (!found?.snapshot) throw new Error("no snapshot");
    return found.snapshot;
  }

  kill(): void {
    this.process.kill("SIGKILL");
  }
}

function readVerdict(paseoHome: string): { file: DaemonVitalsFile; verdict: VitalsVerdict } {
  const read = readDaemonVitals(paseoHome);
  if (read.status !== "ok") throw new Error(`vitals file not readable: ${read.status}`);
  return { file: read.file, verdict: deriveVitalsVerdict(read.file, Date.now()) };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("event-loop monitor in a real process", () => {
  let paseoHome: string;
  let child: Child;

  beforeEach(async () => {
    paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-vitals-"));
    child = new Child(paseoHome);
    await child.waitFor((message) => message.type === "ready");
    // Let the watchdog write its first heartbeat and a few ticks land before the test acts.
    await sleep(400);
  });

  afterEach(async () => {
    child.kill();
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("a main thread stuck computing is a wedge, is visible while it lasts, and is reported on recovery", async () => {
    child.send({ type: "busy", ms: 3_000 });
    await sleep(2_000);

    // Mid-wedge the main thread cannot answer anything, but the watchdog thread keeps the file
    // current: this is what `paseo daemon status` reads.
    const during = readVerdict(paseoHome);
    expect(during.verdict.state).toBe("wedged");

    const recovered = await child.waitFor((message) => message.type === "wedge-recovered");
    expect(recovered.episode?.blockedMs).toBeGreaterThan(2_000);

    const counts = (await child.snapshot()).counts;
    expect(counts).toEqual({ wedges: 1, stalls: 0, suspensions: 0 });
    await sleep(300);
    expect(readVerdict(paseoHome).verdict.state).toBe("healthy");
  });

  test("a main thread parked in a synchronous wait burns no CPU and is still a wedge, not a suspension", async () => {
    child.send({ type: "wait", ms: 2_500 });

    const recovered = await child.waitFor((message) => message.type === "wedge-recovered");
    expect(recovered.episode?.cause).toBe("blocked");
    expect(recovered.episode?.blockedMs).toBeGreaterThan(1_800);
    const counts = (await child.snapshot()).counts;
    expect(counts.suspensions).toBe(0);
    expect(counts.wedges).toBe(1);
  });

  test.skipIf(process.platform === "win32")(
    "a suspended process is a suspension, never a wedge, and pushes nothing",
    async () => {
      // SIGSTOP stops every thread in the process, the same as macOS sleep or App Nap
      // suspending the daemon. Windows has no equivalent signal; the classifier's suspension
      // branches are covered without one in stall-tracker.test.ts.
      process.kill(child.pid, "SIGSTOP");
      await sleep(2_500);
      process.kill(child.pid, "SIGCONT");

      const suspensionLog = await child.waitFor(
        (message) => message.type === "log" && message.msg?.includes("suspended") === true,
      );
      await sleep(600);
      const snapshot = await child.snapshot();
      expect(snapshot.counts).toEqual({ wedges: 0, stalls: 0, suspensions: 1 });

      // Corroboration, not the deciding signal: a stopped process consumes no CPU.
      expect(suspensionLog?.cpuRatio).toBeLessThan(0.3);
      expect(suspensionLog?.blockedMs).toBeLessThan(300);
      expect(suspensionLog?.suspendedMs).toBeGreaterThan(2_000);
      expect(child.messages.some((message) => message.type === "wedge-recovered")).toBe(false);
      expect(readVerdict(paseoHome).verdict.state).toBe("healthy");
    },
  );

  test.skipIf(process.platform === "win32")(
    "a suspension right after a wedge is counted on its own and never added to the wedge",
    async () => {
      child.send({ type: "busy", ms: 1_500 });
      await child.waitFor((message) => message.type === "wedge-recovered");
      process.kill(child.pid, "SIGSTOP");
      await sleep(2_000);
      process.kill(child.pid, "SIGCONT");
      await sleep(600);
      const snapshot = await child.snapshot();
      expect(snapshot.counts).toEqual({ wedges: 1, stalls: 0, suspensions: 1 });
      const recovered = child.messages.filter((message) => message.type === "wedge-recovered");
      expect(recovered).toHaveLength(1);
      expect(recovered[0]?.episode?.blockedMs).toBeLessThan(2_500);
    },
  );
});
