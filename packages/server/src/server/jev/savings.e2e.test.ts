import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

// A real daemon on a temp PASEO_HOME with `PASEO_JEV_BACKEND=fake` (docs/jev.md, "Savings"): a
// question asked over `jev.ask` lands in the savings ledger, and both `jev.savings.*` RPCs read it
// back over the WebSocket. No network, no key: the fake is the only transport.

let ctx: DaemonTestContext;
const saved = process.env.PASEO_JEV_BACKEND;

beforeAll(async () => {
  process.env.PASEO_JEV_BACKEND = "fake";
  ctx = await createDaemonTestContext();
}, 60_000);

afterAll(async () => {
  await ctx?.cleanup();
  if (saved === undefined) delete process.env.PASEO_JEV_BACKEND;
  else process.env.PASEO_JEV_BACKEND = saved;
});

describe("the savings ledger over the WebSocket", () => {
  test("the daemon advertises jevSavings", () => {
    expect(ctx.client.getLastServerInfoMessage()?.features?.jevSavings).toBe(true);
  });

  test("an Ask JEV question shows in the summary and the events", async () => {
    const asked = await ctx.client.jevAsk(
      { context: "", question: { type: "noul", instructions: "Is the build green?" } },
      { timeout: 10_000 },
    );
    expect(asked.outcome).toBe("answered");

    const { summary } = await ctx.client.jevSavingsSummary("today", { timeout: 5_000 });
    expect(summary.unit).toBe("opus-equivalent-weighted-tokens");
    expect(summary.live.involvements).toBe(1);
    expect(summary.live.tokensSaved).toBe(0);
    expect(summary.features.find((f) => f.feature === "askJev")).toMatchObject({
      asked: 1,
      benefit: "none",
    });
    expect(summary.jevSpend.calls).toBe(1);

    const page = await ctx.client.jevSavingsEvents(
      { range: "today", feature: "askJev" },
      { timeout: 5_000 },
    );
    expect(page.events).toMatchObject([
      { feature: "askJev", mode: "live", outcome: "answered", tokensSavedEstimate: null },
    ]);
    expect(page.nextCursor).toBeNull();
  });

  test("a question about an agent carries the agent's title and workspace (review M5)", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "jev-savings-where-"));
    try {
      const created = await ctx.client.createWorkspace({
        source: { kind: "directory", path: cwd },
      });
      const workspaceId = created.workspace?.id;
      if (!workspaceId) throw new Error(created.error ?? "Expected a workspace");
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        workspaceId,
        title: "Billing export",
      });

      const asked = await ctx.client.jevAsk(
        {
          context: "",
          agentId: agent.id,
          question: { type: "noul", instructions: "Is it stuck?" },
        },
        { timeout: 10_000 },
      );
      expect(asked.outcome).toBe("answered");

      const page = await ctx.client.jevSavingsEvents(
        { range: "today", agentId: agent.id },
        { timeout: 5_000 },
      );
      expect(page.events).toMatchObject([
        { feature: "askJev", agentId: agent.id, agentTitle: "Billing export", workspaceId },
      ]);
      const { summary } = await ctx.client.jevSavingsSummary("today", { timeout: 5_000 });
      expect(summary.topAgents).toContainEqual(
        expect.objectContaining({ id: agent.id, label: "Billing export" }),
      );
      expect(summary.topWorkspaces).toContainEqual(
        expect.objectContaining({ id: workspaceId, label: path.basename(cwd) }),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("an unknown range is an rpc_error, not an empty summary", async () => {
    await expect(
      ctx.client.jevSavingsSummary("month" as "today", { timeout: 5_000 }),
    ).rejects.toThrow(/unknown range/);
  });
});
