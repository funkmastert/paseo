import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  DAEMON_STATUS_PROBE_TIMEOUT_MS,
  type DaemonStatus,
  type ProviderBinaryStatus,
  resolveDaemonProbeTarget,
  resolveVitalsRows,
  selectRelayStatus,
  toStatusRows,
} from "./status.js";

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

describe("DAEMON_STATUS_PROBE_TIMEOUT_MS", () => {
  // Matches doctor.ts's `getDaemonStatus({ timeout: 5000 })` for the same RPC. The old 1500ms
  // budget was tighter than the server-side cost of a multi-provider live availability sweep (a
  // Codex bundle-binary probe alone can take ~2s), so it timed out reliably and silently fell back
  // to checkProviderBinaries()'s PATH-only check — "Codex: not found" even when Codex is fine.
  test("is sized for a multi-provider live availability sweep, not a single fast RPC", () => {
    expect(DAEMON_STATUS_PROBE_TIMEOUT_MS).toBe(5000);
  });
});

function baseDaemonStatus(providers: ProviderBinaryStatus[]): DaemonStatus {
  return {
    serverId: "srv_test",
    localDaemon: "running",
    connectedDaemon: "reachable",
    home: "/home/test",
    listen: "127.0.0.1:6767",
    relay: "disabled",
    hostname: "test-host",
    pid: 1,
    startedAt: null,
    owner: null,
    logPath: "/home/test/daemon.log",
    daemonNode: "/usr/bin/node",
    cliNode: "/usr/bin/node",
    cliVersion: "0.0.0",
    daemonVersion: "0.0.0",
    desktopManaged: false,
    eventLoop: null,
    lastWedge: null,
    lastShutdown: null,
    providers,
  };
}

function providerRow(rows: ReturnType<typeof toStatusRows>, label: string) {
  const row = rows.find((r) => r.key.trim() === label);
  if (!row) throw new Error(`no row for ${label}`);
  return row.value;
}

describe("toStatusRows provider source marking", () => {
  // The daemon's own answer (statusPayload.providers via probeDaemonOverWebsocket) is tagged
  // "daemon" and must keep reading that way.
  test("a daemon-reported provider is tagged (daemon), found or not", () => {
    const rows = toStatusRows(
      baseDaemonStatus([
        { label: "Claude", path: "available", version: null, source: "daemon" },
        { label: "Codex", path: null, version: "no client registered", source: "daemon" },
      ]),
    );
    expect(providerRow(rows, "Claude")).toBe("available (daemon)");
    expect(providerRow(rows, "Codex")).toBe("not found (daemon)");
  });

  // checkProviderBinaries()'s PATH-only fallback runs when the daemon detail request fails (or
  // was never made) and must never render indistinguishably from a daemon-reported row — that was
  // the exact bug: "Codex: not found" from a local `which codex` read as if the live daemon,
  // which had already discovered Codex via the ChatGPT bundle and a green guard self-test, had
  // said so.
  test("a local PATH-only provider is tagged (local), found or not", () => {
    const rows = toStatusRows(
      baseDaemonStatus([
        { label: "Claude", path: "/usr/local/bin/claude", version: "2.0.0", source: "local" },
        { label: "Codex", path: null, version: null, source: "local" },
        { label: "OpenCode", path: "/usr/local/bin/opencode", version: null, source: "local" },
      ]),
    );
    expect(providerRow(rows, "Claude")).toBe("/usr/local/bin/claude (2.0.0) (local)");
    expect(providerRow(rows, "Codex")).toBe("not found (local)");
    expect(providerRow(rows, "OpenCode")).toBe(
      "/usr/local/bin/opencode (--version failed) (local)",
    );
  });

  // A provider record with no `source` at all can only come from the local fallback (the daemon
  // path always sets "daemon" explicitly) — treat it the same as an explicit "local", never as an
  // unmarked/ambiguous row.
  test("a provider with no source at all is still tagged (local), not left unmarked", () => {
    const rows = toStatusRows(
      baseDaemonStatus([{ label: "Codex", path: null, version: null } as ProviderBinaryStatus]),
    );
    expect(providerRow(rows, "Codex")).toBe("not found (local)");
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
