import { describe, expect, test } from "vitest";
import { CLIENT_SHUTDOWN_RPC_REASON } from "../lifecycle-reasons.js";
import { describePreviousShutdown, legacyPreviousShutdownString } from "./shutdown-reason.js";
import type { ShutdownReceipt } from "./shutdown-receipt.js";

function receipt(overrides: Partial<ShutdownReceipt> = {}): ShutdownReceipt {
  return {
    schema: "paseo.daemon-shutdown/v1",
    pid: 123,
    outcome: "clean",
    reason: "worker_received_SIGTERM",
    signal: "SIGTERM",
    phase: "complete",
    startedAt: "2026-09-29T20:49:00.000Z",
    completedAt: "2026-09-29T20:49:10.000Z",
    budgetMs: 10_000,
    exitCode: 0,
    failures: [],
    ...overrides,
  };
}

describe("describePreviousShutdown", () => {
  test("a SIGTERM from the supervisor reads as Bozeo quitting, even if the budget ran out", () => {
    const info = describePreviousShutdown({
      previous: {
        status: "receipt",
        receipt: receipt({ outcome: "timed-out", reason: "worker_received_SIGTERM" }),
      },
      systemBootAt: null,
      lastHeartbeatAt: null,
    });
    expect(info).toEqual({
      reason: "bozeo_quit",
      at: "2026-09-29T20:49:10.000Z",
      detail: "shutdown budget exhausted",
    });
  });

  test("a graceful supervisor IPC shutdown also reads as Bozeo quitting", () => {
    const info = describePreviousShutdown({
      previous: {
        status: "receipt",
        receipt: receipt({ signal: "Supervisor shutdown request", reason: "some_reason" }),
      },
      systemBootAt: null,
      lastHeartbeatAt: null,
    });
    expect(info.reason).toBe("bozeo_quit");
  });

  test("the self-update restart reads as restarted for an update", () => {
    const info = describePreviousShutdown({
      previous: { status: "receipt", receipt: receipt({ reason: "daemon_update", signal: null }) },
      systemBootAt: null,
      lastHeartbeatAt: null,
    });
    expect(info.reason).toBe("update");
  });

  test("a client shutdown RPC reads as stopped from the command line", () => {
    const info = describePreviousShutdown({
      previous: {
        status: "receipt",
        receipt: receipt({ reason: CLIENT_SHUTDOWN_RPC_REASON, signal: null }),
      },
      systemBootAt: null,
      lastHeartbeatAt: null,
    });
    expect(info.reason).toBe("cli_stop");
  });

  test("a crashed receipt reads as crashed, whatever its signal or reason", () => {
    const info = describePreviousShutdown({
      previous: {
        status: "receipt",
        receipt: receipt({ outcome: "crashed", failures: [{ phase: "running", error: "boom" }] }),
      },
      systemBootAt: null,
      lastHeartbeatAt: null,
    });
    expect(info).toEqual({ reason: "crashed", at: "2026-09-29T20:49:10.000Z", detail: "boom" });
  });

  test("no receipt, and the machine rebooted since the last heartbeat, reads as power loss", () => {
    const info = describePreviousShutdown({
      previous: { status: "none" },
      systemBootAt: new Date("2026-09-30T08:00:00.000Z"),
      lastHeartbeatAt: new Date("2026-09-29T20:50:00.000Z"),
    });
    expect(info).toEqual({ reason: "power_loss", at: "2026-09-30T08:00:00.000Z" });
  });

  test("no receipt, and no reboot evidence, reads as crashed", () => {
    const info = describePreviousShutdown({
      previous: { status: "none" },
      systemBootAt: new Date("2026-09-29T08:00:00.000Z"),
      lastHeartbeatAt: new Date("2026-09-29T20:50:00.000Z"),
    });
    expect(info).toEqual({ reason: "crashed", at: null });
  });

  test("no receipt, and nothing to check a reboot against, reads as crashed", () => {
    const info = describePreviousShutdown({
      previous: { status: "none" },
      systemBootAt: new Date("2026-09-30T08:00:00.000Z"),
      lastHeartbeatAt: null,
    });
    expect(info).toEqual({ reason: "crashed", at: null });
  });

  test("an unreadable receipt reads as unknown, with the error as detail", () => {
    const info = describePreviousShutdown({
      previous: { status: "unreadable", error: "bad json" },
      systemBootAt: null,
      lastHeartbeatAt: null,
    });
    expect(info).toEqual({ reason: "unknown", at: null, detail: "bad json" });
  });

  test("an unrecognized signal and reason read as unknown rather than guessing", () => {
    const info = describePreviousShutdown({
      previous: {
        status: "receipt",
        receipt: receipt({ signal: null, reason: "something_else" }),
      },
      systemBootAt: null,
      lastHeartbeatAt: null,
    });
    expect(info.reason).toBe("unknown");
  });
});

describe("legacyPreviousShutdownString", () => {
  test("maps every reason except crashed and unknown to clean", () => {
    expect(legacyPreviousShutdownString({ reason: "bozeo_quit", at: null })).toBe("clean");
    expect(legacyPreviousShutdownString({ reason: "update", at: null })).toBe("clean");
    expect(legacyPreviousShutdownString({ reason: "cli_stop", at: null })).toBe("clean");
    expect(legacyPreviousShutdownString({ reason: "power_loss", at: null })).toBe("clean");
    expect(legacyPreviousShutdownString({ reason: "crashed", at: null })).toBe("crash");
    expect(legacyPreviousShutdownString({ reason: "unknown", at: null })).toBe("unknown");
  });
});
