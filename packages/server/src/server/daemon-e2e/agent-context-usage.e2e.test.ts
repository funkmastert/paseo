import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

/**
 * Proves the wire end to end against an isolated daemon (never port 6767): the capability is
 * advertised, and a read reaches the agent's session through the session dispatch, the permission
 * table and the daemon-wide cache.
 */
describe("agent.context_usage.read against an isolated daemon", () => {
  let ctx: DaemonTestContext;
  let cwd: string;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
    cwd = mkdtempSync(path.join(tmpdir(), "context-usage-e2e-"));
  });

  afterEach(async () => {
    await ctx.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }, 60_000);

  test("advertises the capability", () => {
    expect(ctx.client.getLastServerInfoMessage()?.features?.agentContextUsage).toBe(true);
  });

  test("captures an idle agent's breakdown, then serves it from the cache", async () => {
    const agent = await ctx.client.createAgent({ provider: "claude", cwd, title: "Context usage" });

    const first = await ctx.client.readAgentContextUsage(agent.id);
    expect(first.agentId).toBe(agent.id);
    expect(first.status).toBe("captured");
    expect(first.error).toBeNull();
    expect(first.usage?.totalTokens).toBe(1_200);
    expect(first.usage?.categories.map((row) => row.kind)).toEqual(["used", "free"]);

    const second = await ctx.client.readAgentContextUsage(agent.id);
    expect(second.status).toBe("cached");
    expect(second.usage?.capturedAt).toBe(first.usage?.capturedAt);
  });

  test("answers an unknown agent with an error instead of timing out", async () => {
    const payload = await ctx.client.readAgentContextUsage("no-such-agent");

    expect(payload.status).toBe("error");
    expect(payload.usage).toBeNull();
    expect(payload.error).toBeTruthy();
  });
});
