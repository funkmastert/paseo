import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, expect, test } from "vitest";

import { createDaemonTestContext, type DaemonTestContext } from "./test-utils/index.js";
import { ScriptedClient, type ScriptedTurn } from "./test-utils/scripted-context-agent-client.js";

// A real daemon on a temp PASEO_HOME: config, bootstrap wiring, the WebSocket send path and the
// dispatch hook all run for real. The provider is scripted so the test can say how large the
// context is after each turn, and see every prompt the agent was actually handed.

let ctx: DaemonTestContext;
let client: ScriptedClient;
let logs: Array<Record<string, unknown>>;
let workdir: string;

beforeEach(async () => {
  client = new ScriptedClient();
  logs = [];
  workdir = mkdtempSync(path.join(tmpdir(), "refocus-e2e-"));
  ctx = await createDaemonTestContext({
    agentClients: { codex: client },
    refocus: { enabled: true, dryRun: true, growthTokens: 300_000 },
    logger: pino(
      { level: "info" },
      { write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>) },
    ),
  });
});

afterEach(async () => {
  await ctx.cleanup();
  rmSync(workdir, { recursive: true, force: true });
});

function refocusLogs(): Array<Record<string, unknown>> {
  return logs.filter((record) => String(record.msg).startsWith("Refocus"));
}

async function send(agentId: string, text: string, turn: ScriptedTurn = {}): Promise<string> {
  const session = client.sessions[0]!;
  session.script.push(turn);
  const before = session.prompts.length;
  await ctx.client.sendMessage(agentId, text);
  await ctx.client.waitForFinish(agentId, 10_000);
  return session.prompts[before]!;
}

test("dry run reports the refocus on the prompt that would carry it, then live mode delivers", async () => {
  const agent = await ctx.client.createAgent({ provider: "codex", cwd: workdir });
  await send(agent.id, "Build the billing export for Acme.", { contextTokens: 20_000 });
  await send(agent.id, "Keep going.", { contextTokens: 380_000 });

  expect(await send(agent.id, "Next step.")).toBe("Next step.");
  expect(refocusLogs().map((record) => record.msg)).toEqual([
    "Refocus due; waiting for the agent's next prompt",
    "Refocus (dry run): would append to this prompt",
  ]);
  expect(refocusLogs()[1]).toMatchObject({
    agentId: agent.id,
    reason: "growth",
    growthTokens: 360_000,
    carrier: "prompt starting a turn",
  });

  await ctx.client.patchDaemonConfig({ refocus: { dryRun: false } });
  await send(agent.id, "Wrap up this phase.", { compacts: true, contextTokens: 30_000 });
  const carried = await send(agent.id, "Restore from the packet.");

  expect(carried).toContain("Restore from the packet.\n\n<paseo-system>\nRefocus (your context");
  expect(carried).toContain("<assignment>\nBuild the billing export for Acme.\n</assignment>");
  expect(refocusLogs().at(-1)).toMatchObject({ msg: "Refocus delivered", reason: "compaction" });
  // Nothing but the five prompts sent above ever reached the agent.
  expect(client.sessions[0]!.prompts).toHaveLength(5);
});
