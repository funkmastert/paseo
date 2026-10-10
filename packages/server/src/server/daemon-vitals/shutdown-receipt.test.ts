import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  consumePreviousShutdownReceipt,
  readLastShutdownReceipt,
  readShutdownReceipt,
  ShutdownRecorder,
  shutdownReceiptPath,
} from "./shutdown-receipt.js";

describe("shutdown receipt", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "paseo-receipt-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function recorder(reason = "worker_received_SIGTERM", signal: string | null = "SIGTERM") {
    return new ShutdownRecorder({ paseoHome: home, reason, signal });
  }

  test("a clean stop writes a clean receipt naming the reason and the pid", () => {
    const r = recorder();
    r.enter("daemon-stop");
    const { writeError } = r.finish({ outcome: "clean", exitCode: 0 });

    expect(writeError).toBeNull();
    const read = readShutdownReceipt(home);
    expect(read.status === "ok" && read.receipt).toMatchObject({
      outcome: "clean",
      reason: "worker_received_SIGTERM",
      signal: "SIGTERM",
      phase: "complete",
      pid: process.pid,
      exitCode: 0,
      failures: [],
    });
  });

  test("a stop that ran out of budget says which step was running", () => {
    const r = recorder();
    r.enter("daemon-stop");
    r.fail(new Error("shutdown budget of 10000ms exhausted"));
    r.finish({ outcome: "timed-out", exitCode: 1 });

    const read = readShutdownReceipt(home);
    expect(read.status === "ok" && read.receipt).toMatchObject({
      outcome: "timed-out",
      phase: "daemon-stop",
      exitCode: 1,
      failures: [{ phase: "daemon-stop", error: "shutdown budget of 10000ms exhausted" }],
    });
  });

  test("a failed stop and a crash are their own outcomes", () => {
    const failed = recorder();
    failed.enter("daemon-stop");
    failed.fail(new Error("port stuck"));
    failed.finish({ outcome: "failed", exitCode: 1 });
    const failedRead = readShutdownReceipt(home);
    expect(failedRead.status === "ok" && failedRead.receipt.outcome).toBe("failed");

    const crashed = recorder("uncaught_exception", null);
    crashed.enter("running");
    crashed.fail(new Error("TypeError: x is undefined"));
    crashed.finish({ outcome: "crashed", exitCode: 1 });
    const crashedRead = readShutdownReceipt(home);
    expect(crashedRead.status === "ok" && crashedRead.receipt).toMatchObject({
      outcome: "crashed",
      reason: "uncaught_exception",
      signal: null,
      phase: "running",
    });
  });

  test("the first outcome wins: a timer or a crash handler cannot rewrite it", () => {
    const r = recorder();
    r.finish({ outcome: "clean", exitCode: 0 });
    r.finish({ outcome: "timed-out", exitCode: 1 });
    const read = readShutdownReceipt(home);
    expect(read.status === "ok" && read.receipt.outcome).toBe("clean");
  });

  test("the write is atomic: no temp file is left behind", async () => {
    recorder().finish({ outcome: "clean", exitCode: 0 });
    expect(await readdir(home)).toEqual(["daemon-shutdown.json"]);
    JSON.parse(await readFile(shutdownReceiptPath(home), "utf8"));
  });

  test("an unwritable home is reported, not thrown", () => {
    const r = new ShutdownRecorder({
      paseoHome: path.join(home, "missing", "deeper"),
      reason: "x",
      signal: null,
    });
    const { writeError, receipt } = r.finish({ outcome: "clean", exitCode: 0 });
    expect(writeError).toBeInstanceOf(Error);
    expect(receipt.outcome).toBe("clean");
  });

  test("startup moves the last run's receipt aside so a stale clean cannot describe a crash", async () => {
    recorder().finish({ outcome: "clean", exitCode: 0 });

    const previous = consumePreviousShutdownReceipt(home);
    expect(previous.status === "receipt" && previous.receipt.outcome).toBe("clean");
    expect(readShutdownReceipt(home).status).toBe("missing");

    // This run never writes one (it was killed): the next start sees none, not the old clean.
    expect(consumePreviousShutdownReceipt(home)).toEqual({ status: "none" });

    // A running daemon's "last shutdown" is the receipt it moved aside.
    const last = readLastShutdownReceipt(home, true);
    expect(last.status === "ok" && last.receipt.outcome).toBe("clean");
    expect(readLastShutdownReceipt(home, false).status).toBe("missing");
  });

  test("an unreadable receipt is reported and moved aside rather than trusted", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(shutdownReceiptPath(home), "{not json");
    const previous = consumePreviousShutdownReceipt(home);
    expect(previous.status).toBe("unreadable");
    expect(readShutdownReceipt(home).status).toBe("missing");
  });

  test("no receipt at all means the previous run left nothing", () => {
    expect(consumePreviousShutdownReceipt(home)).toEqual({ status: "none" });
  });
});
