import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Proves the wire end to end against an isolated daemon (never port 6767): a history written by a
 * previous daemon run is read through the real WebSocket, gated and authorised like any other
 * daemon.read RPC, and turned into projections at request time.
 */
describe("usage.history.get against an isolated daemon", () => {
  let homeRoot: string;
  let daemon: TestPaseoDaemon;
  let client: DaemonClient;

  beforeEach(async () => {
    homeRoot = await mkdtemp(path.join(os.tmpdir(), "usage-history-e2e-"));
    const historyDir = path.join(homeRoot, ".paseo", "usage-history");
    await mkdir(path.join(historyDir, "agents"), { recursive: true });

    const now = Date.now();
    const fiveHourSamples: Array<[number, number, number]> = [];
    // An hour of five-minute fetches, filling at 20 points an hour, ending a minute ago.
    for (let index = 12; index >= 0; index -= 1) {
      const atMs = now - MINUTE - index * 5 * MINUTE;
      fiveHourSamples.push([atMs, 50 - index * (20 / 12), now + 5 * HOUR]);
    }
    await writeFile(
      path.join(historyDir, "accounts.json"),
      JSON.stringify({
        v: 1,
        series: [
          {
            providerId: "claude-personal",
            windowId: "five_hour",
            label: "Session",
            samples: fiveHourSamples,
          },
          {
            providerId: "claude-personal",
            windowId: "weekly_model_fable",
            label: "Fable weekly",
            samples: [[now - MINUTE, 12, now + 3 * 24 * HOUR]],
          },
        ],
      }),
    );
    // A spend series the previous daemon left: 5M weighted tokens spent before it went down.
    await writeFile(
      path.join(historyDir, "agents", "agent-e2e.json"),
      JSON.stringify({
        v: 1,
        agentId: "agent-e2e",
        offset: 1_000_000,
        lastRaw: 4_000_000,
        samples: [
          [now - 3 * HOUR, 1_000_000],
          [now - 2 * HOUR, 3_000_000],
          [now - HOUR, 5_000_000],
        ],
      }),
    );

    daemon = await createTestPaseoDaemon({ paseoHomeRoot: homeRoot });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.2" });
    await client.connect();
  });

  afterEach(async () => {
    await client.close();
    await daemon.close();
    await rm(homeRoot, { recursive: true, force: true });
  }, 60_000);

  test("serves projections and an agent's spend over the real protocol", async () => {
    const payload = await client.getUsageHistory({ agentId: "agent-e2e" });

    const account = payload.accounts.find((entry) => entry.providerId === "claude-personal");
    const session = account?.windows.find((window) => window.windowId === "five_hour");
    expect(session?.projection.status).toBe("projected");
    // 50% at 20 points an hour, a minute ago: capped in about 2.5 hours, well inside the 5-hour window.
    expect(session?.projection.ratePctPerHour).toBeCloseTo(20, 0);
    expect(session?.projection.minutesToCap).toBeGreaterThan(120);
    expect(session?.projection.minutesToCap).toBeLessThan(160);
    expect(Date.parse(session?.projection.capsAt ?? "")).toBeGreaterThan(Date.now());

    // One reading is not a rate: the daemon says so instead of inventing one.
    const fable = account?.windows.find((window) => window.windowId === "weekly_model_fable");
    expect(fable?.projection).toMatchObject({
      status: "unknown",
      reason: "insufficient_samples",
    });

    // A new daemon process starts a new counter epoch, so the previous run's last reading is
    // folded into the total rather than dropped: 1M offset + 4M lastRaw.
    expect(payload.agent?.agentId).toBe("agent-e2e");
    expect(payload.agent?.totalWeightedTokens).toBe(5_000_000);
    expect(payload.agent?.points).toHaveLength(3);
  });

  test("leaves the agent out when none is named", async () => {
    const payload = await client.getUsageHistory();
    expect(payload.agent).toBeUndefined();
    expect(payload.accounts).toHaveLength(1);
  });
});
