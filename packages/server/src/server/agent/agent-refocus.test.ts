import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { formatSystemNotificationPrompt, startAgentRun } from "./agent-prompt.js";
import { AgentRefocus, type RefocusConfig, readRefocusBrief } from "./agent-refocus.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import {
  ScriptedClient,
  type ScriptedSession,
  type ScriptedTurn,
} from "../test-utils/scripted-context-agent-client.js";

interface Scenario {
  session: ScriptedSession;
  config: { refocus?: RefocusConfig };
  logs: Array<Record<string, unknown>>;
  /** Sends a prompt through the production dispatch path and waits for its turn to finish. */
  send(prompt: string, turn?: ScriptedTurn): Promise<string>;
  logMessages(): string[];
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function createScenario(refocus: RefocusConfig): Promise<Scenario> {
  const workdir = mkdtempSync(join(tmpdir(), "agent-refocus-"));
  const client = new ScriptedClient();
  const agentManager = new AgentManager({ clients: { codex: client }, logger: createTestLogger() });
  const config: { refocus?: RefocusConfig } = { refocus };
  const logs: Array<Record<string, unknown>> = [];
  const logger = pino(
    { level: "info" },
    { write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>) },
  );
  const agentRefocus = new AgentRefocus({ agentManager, readDaemonConfig: () => config, logger });
  agentManager.setPromptDispatchInterceptor((agentId, prompt) =>
    agentRefocus.interceptPrompt(agentId, prompt),
  );
  agentRefocus.start();
  const snapshot = await agentManager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });
  const session = client.sessions[0]!;
  cleanups.push(async () => {
    agentRefocus.stop();
    await agentManager.closeAgent(snapshot.id).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  });

  return {
    session,
    config,
    logs,
    async send(prompt, turn = {}) {
      session.script.push(turn);
      const before = session.prompts.length;
      await startAgentRun(agentManager, snapshot.id, prompt, createTestLogger());
      await vi.waitFor(() => {
        expect(session.prompts.length).toBe(before + 1);
        expect(agentManager.getAgent(snapshot.id)?.lifecycle).toBe("idle");
      });
      return session.prompts[before]!;
    },
    logMessages: () => logs.map((record) => String(record.msg)),
  };
}

test("after enough growth, the next prompt carries the assignment verbatim", async () => {
  const scenario = await createScenario({ enabled: true, growthTokens: 300_000 });
  await scenario.send("Build the billing export for Acme.", { contextTokens: 20_000 });
  await scenario.send("Keep going.", { contextTokens: 380_000 });

  const carried = await scenario.send("Next step, please.");

  expect(carried.startsWith("Next step, please.\n\n<paseo-system>\nRefocus (about 360K")).toBe(
    true,
  );
  expect(carried).toContain("<assignment>\nBuild the billing export for Acme.\n</assignment>");
  expect(carried).toContain("What outcome is this work for?");
  expect(scenario.logMessages()).toContain("Refocus delivered");
});

test("a due refocus never starts a turn of its own, and is spent once delivered", async () => {
  const scenario = await createScenario({ enabled: true, growthTokens: 300_000 });
  await scenario.send("Build the billing export for Acme.", { contextTokens: 20_000 });
  await scenario.send("Keep going.", { contextTokens: 380_000 });
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(scenario.session.prompts).toHaveLength(2);
  expect(scenario.logMessages()).toContain("Refocus due; waiting for the agent's next prompt");

  expect(await scenario.send("Next step.")).toContain("<paseo-system>\nRefocus (");
  expect(await scenario.send("And the one after.")).toBe("And the one after.");
});

test("growth below the threshold changes nothing", async () => {
  const scenario = await createScenario({ enabled: true, growthTokens: 300_000 });
  await scenario.send("Build the billing export for Acme.", { contextTokens: 20_000 });
  await scenario.send("Keep going.", { contextTokens: 200_000 });

  expect(await scenario.send("Next step.")).toBe("Next step.");
});

test("a compaction does not count as growth, and the smaller context is the new baseline", async () => {
  const scenario = await createScenario({
    enabled: true,
    growthTokens: 300_000,
    onCompaction: false,
  });
  await scenario.send("Build the billing export for Acme.", { contextTokens: 250_000 });
  await scenario.send("Keep going.", { contextTokens: 40_000 });
  await scenario.send("Keep going.", { contextTokens: 240_000 });

  expect(await scenario.send("Next step.")).toBe("Next step.");
});

test("after a compaction the refocus skips the /compact prompt and rides on the restore", async () => {
  const scenario = await createScenario({ enabled: true });
  await scenario.send("Coordinate the Android release.", { contextTokens: 20_000 });
  await scenario.send("Wrap up this phase.", { compacts: true, contextTokens: 30_000 });

  expect(await scenario.send("/compact keep the open PR list")).toBe(
    "/compact keep the open PR list",
  );
  const restore = await scenario.send(formatSystemNotificationPrompt("Restore from the packet."));

  expect(restore).toContain("Refocus (your context was just compacted)");
  expect(restore).toContain("<assignment>\nCoordinate the Android release.\n</assignment>");
});

test("the latest direction from a person is quoted, and notifications are not direction", async () => {
  const scenario = await createScenario({ enabled: true, growthTokens: 300_000 });
  await scenario.send("Build the billing export for Acme.", { contextTokens: 20_000 });
  await scenario.send("Drop CSV; ship the JSON export only.", { contextTokens: 100_000 });
  await scenario.send(formatSystemNotificationPrompt("Agent a1 finished."), {
    contextTokens: 400_000,
  });

  const carried = await scenario.send(formatSystemNotificationPrompt("Agent a2 finished."));

  expect(carried).toContain(
    "<latest-direction>\nDrop CSV; ship the JSON export only.\n</latest-direction>",
  );
});

test("dry run logs the block it would have sent and leaves the prompt alone", async () => {
  const scenario = await createScenario({ enabled: true, dryRun: true, growthTokens: 300_000 });
  await scenario.send("Build the billing export for Acme.", { contextTokens: 20_000 });
  await scenario.send("Keep going.", { contextTokens: 380_000 });

  expect(await scenario.send("Next step.")).toBe("Next step.");
  const dryRun = scenario.logs.filter(
    (record) => record.msg === "Refocus (dry run): would append to this prompt",
  );
  expect(dryRun).toHaveLength(1);
  expect(dryRun[0]).toMatchObject({ reason: "growth", growthTokens: 360_000 });
  expect(String(dryRun[0]?.block)).toContain("Build the billing export for Acme.");

  await scenario.send("And again.");
  expect(
    scenario.logs.filter(
      (record) => record.msg === "Refocus (dry run): would append to this prompt",
    ),
  ).toHaveLength(1);
});

test("off by default", async () => {
  const scenario = await createScenario({});
  await scenario.send("Build the billing export for Acme.", { contextTokens: 20_000 });
  await scenario.send("Keep going.", { contextTokens: 900_000, compacts: true });

  expect(await scenario.send("Next step.")).toBe("Next step.");
  expect(scenario.logMessages().filter((msg) => msg.startsWith("Refocus"))).toEqual([]);
});

test("an earlier refocus riding on a message is not quoted back as direction", () => {
  const items: AgentTimelineItem[] = [
    { type: "user_message", text: "Build the billing export for Acme." },
    {
      type: "user_message",
      text: "Ship JSON only.\n\n<paseo-system>\nRefocus (about 300K tokens).\nold\n</paseo-system>",
    },
  ];

  expect(readRefocusBrief(items)).toEqual({
    assignment: "Build the billing export for Acme.",
    latestDirection: "Ship JSON only.",
  });
});
