import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveDaemonProbeTarget, resolveVitalsRows, selectRelayStatus } from "./status.js";

describe("resolveDaemonProbeTarget", () => {
  const originalHost = process.env.PASEO_HOST;
  afterEach(() => {
    if (originalHost === undefined) delete process.env.PASEO_HOST;
    else process.env.PASEO_HOST = originalHost;
  });

  // N22: `daemon status` used to probe state.listen (the local daemon's own persisted config)
  // regardless of --host/PASEO_HOST, so it reported on the wrong daemon when either was set to
  // point somewhere else — unlike every other command.
  test("honours PASEO_HOST, the same as every other command", () => {
    process.env.PASEO_HOST = "example.internal:9999";
    expect(resolveDaemonProbeTarget({})).toBe("example.internal:9999");
  });

  test("an explicit --host wins over PASEO_HOST", () => {
    process.env.PASEO_HOST = "example.internal:9999";
    expect(resolveDaemonProbeTarget({ host: "other.internal:1111" })).toBe("other.internal:1111");
  });
});

describe("selectRelayStatus", () => {
  const persisted = {
    enabled: false,
    endpoint: "persisted.internal:443",
    publicEndpoint: "persisted.example.com:443",
    useTls: true,
    publicUseTls: true,
  };

  test("uses the running daemon relay state over persisted config", () => {
    expect(
      selectRelayStatus({
        persisted,
        live: {
          enabled: true,
          endpoint: "live.internal:443",
          publicEndpoint: "live.example.com:443",
          useTls: true,
          publicUseTls: true,
        },
      }),
    ).toBe("wss://live.example.com:443");
  });

  test("falls back to persisted config when the daemon cannot report live state", () => {
    expect(selectRelayStatus({ persisted })).toBe("disabled");
  });
});

describe("resolveVitalsRows", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  function homeWith(files: Record<string, unknown>): string {
    const home = mkdtempSync(path.join(os.tmpdir(), "paseo-status-vitals-"));
    homes.push(home);
    mkdirSync(path.join(home, "diagnostics"), { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(path.join(home, name), JSON.stringify(body));
    }
    return home;
  }

  function vitals(overrides: Record<string, unknown> = {}) {
    return {
      schema: "paseo.daemon-vitals/v1",
      pid: 99,
      startedAt: new Date(Date.now() - 5_000).toISOString(),
      updatedAtMs: Date.now() - 300,
      mainTickAtMs: Date.now() - 400,
      mainBlockedMs: 0,
      thresholds: { tickMs: 250, slowStallMs: 500, wedgeMs: 5_000, suspendMs: 2_000 },
      dryRun: true,
      summary: null,
      ...overrides,
    };
  }

  const daemonStartedAt = new Date(Date.now() - 10_000).toISOString();

  test("a wedged daemon is reported as wedged and alive, never as down", () => {
    const home = homeWith({ "diagnostics/daemon-vitals.json": vitals({ mainBlockedMs: 41_000 }) });
    const rows = resolveVitalsRows({ home, running: true, daemonStartedAt });
    expect(rows.eventLoop).toContain("wedged");
    expect(rows.eventLoop).toContain("alive");
    expect(rows.blocked).toBe(true);
  });

  test("a healthy daemon is healthy", () => {
    const home = homeWith({ "diagnostics/daemon-vitals.json": vitals() });
    expect(resolveVitalsRows({ home, running: true, daemonStartedAt })).toMatchObject({
      eventLoop: "healthy",
      blocked: false,
    });
  });

  test("a heartbeat file left by an earlier run is not this daemon's", () => {
    const home = homeWith({
      "diagnostics/daemon-vitals.json": vitals({
        startedAt: new Date(Date.now() - 3_600_000).toISOString(),
        updatedAtMs: Date.now() - 3_000_000,
      }),
    });
    expect(resolveVitalsRows({ home, running: true, daemonStartedAt })).toMatchObject({
      eventLoop: "not reporting",
      blocked: false,
    });
  });

  test("a stopped daemon shows its shutdown receipt and no event loop", () => {
    const home = homeWith({
      "daemon-shutdown.json": {
        schema: "paseo.daemon-shutdown/v1",
        pid: 1,
        outcome: "timed-out",
        reason: "worker_received_SIGTERM",
        signal: "SIGTERM",
        phase: "daemon-stop",
        startedAt: "2026-09-23T00:00:00.000Z",
        completedAt: "2026-09-23T00:00:10.000Z",
        budgetMs: 10_000,
        exitCode: 1,
        failures: [],
      },
    });
    const rows = resolveVitalsRows({ home, running: false, daemonStartedAt: null });
    expect(rows.eventLoop).toBeNull();
    expect(rows.lastShutdown).toContain("timed-out");
  });
});
