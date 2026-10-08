import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { claudeAssistantLine } from "../token-usage/test-utils/fixtures.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Proves the wire end to end against an isolated daemon (never port 6767): the daemon's own
 * timer backfills a transcript tree the test owns, and the breakdown comes back over the real
 * WebSocket, gated and authorised like any other daemon.read RPC.
 */
describe("usage.tokens.get_breakdown against an isolated daemon", () => {
  let homeRoot: string;
  let daemon: TestPaseoDaemon;
  let client: DaemonClient;

  beforeEach(async () => {
    homeRoot = await mkdtemp(path.join(os.tmpdir(), "token-usage-e2e-"));
    const projects = path.join(homeRoot, "claude", "projects");
    const transcript = path.join(projects, "-fake-project", "fake-session.jsonl");
    await mkdir(path.dirname(transcript), { recursive: true });
    const at = new Date(Date.now() - 2 * HOUR).toISOString();
    await writeFile(
      transcript,
      `${[
        claudeAssistantLine({
          messageId: "m1",
          sessionId: "fake-session",
          timestamp: at,
          output: 100,
        }),
        claudeAssistantLine({
          messageId: "m1",
          sessionId: "fake-session",
          timestamp: at,
          output: 100,
        }),
        claudeAssistantLine({
          messageId: "m2",
          sessionId: "fake-session",
          timestamp: at,
          output: 50,
        }),
      ].join("\n")}\n`,
    );
    const mtime = new Date(Date.now() - HOUR);
    await utimes(transcript, mtime, mtime);

    daemon = await createTestPaseoDaemon({
      paseoHomeRoot: homeRoot,
      tokenUsageOverrides: {
        roots: [{ provider: "claude", dir: projects }],
        firstSweepDelayMs: 0,
      },
    });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.2" });
    await client.connect();
  });

  afterEach(async () => {
    await client.close();
    await daemon.close();
    await rm(homeRoot, { recursive: true, force: true });
  }, 60_000);

  test("advertises the feature and serves the backfilled breakdown over the real protocol", async () => {
    expect(client.getLastServerInfoMessage()?.features?.tokenUsage).toBe(true);

    await vi.waitFor(
      async () => {
        const payload = await client.getTokenUsageBreakdown({ range: "24h" });
        expect(payload.coverage.backfill.state).toBe("done");
      },
      { timeout: 20_000, interval: 250 },
    );
    const payload = await client.getTokenUsageBreakdown({ range: "7d" });

    expect(payload.range).toBe("7d");
    expect(payload.coverage).toMatchObject({
      enabled: true,
      backfill: { state: "done", filesDone: 1, filesTotal: 1 },
    });
    // No agent owns the session: it books as outside, each response once.
    expect(payload.rows).toEqual([
      expect.objectContaining({
        provider: "claude",
        model: "claude-opus-5-5",
        role: "outside",
        output: 150,
        responses: 2,
      }),
    ]);
  });
});
