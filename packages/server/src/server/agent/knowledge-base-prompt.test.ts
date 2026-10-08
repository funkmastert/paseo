import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentSnapshot } from "../knowledge-base/assignments.js";
import {
  ScriptedClient,
  type ScriptedSession,
} from "../test-utils/scripted-context-agent-client.js";
import { AgentManager, type PromptDispatchInterceptor } from "./agent-manager.js";
import { startAgentRun } from "./agent-prompt.js";
import { appendRefocusToPrompt } from "./agent-refocus.js";
import {
  KNOWLEDGE_BASE_GUIDANCE,
  KnowledgeBaseFirstPromptSummary,
  buildKnowledgeBaseSystemPrompt,
  composePromptDispatchInterceptors,
  type KnowledgeBasePromptSource,
} from "./knowledge-base-prompt.js";

const SUMMARY =
  "Knowledge-base project for this session: Checkout redesign (checkout-redesign).\n" +
  'Call kb_open("checkout-redesign") for the links, decisions, rules and status before relying on them.';
const SUMMARY_BLOCK = `<paseo-system>\n${SUMMARY}\n</paseo-system>`;

function source(input: { enabled?: boolean; snapshots?: Record<string, string> } = {}) {
  const snapshots = input.snapshots ?? {};
  const knowledgeBase: KnowledgeBasePromptSource = {
    isEnabled: () => input.enabled ?? true,
    getSnapshot: (agentId: string): AgentSnapshot | null =>
      snapshots[agentId]
        ? { project: "checkout-redesign", text: snapshots[agentId], takenAt: "2026-10-08" }
        : null,
  };
  return knowledgeBase;
}

describe("the system-prompt addition", () => {
  test("the guidance stays under 120 tokens and names the four tools", () => {
    expect(Math.ceil(KNOWLEDGE_BASE_GUIDANCE.length / 4)).toBeLessThan(120);
    for (const tool of ["kb_search", "kb_open", "kb_create", "kb_record"]) {
      expect(KNOWLEDGE_BASE_GUIDANCE).toContain(tool);
    }
  });

  test("is the guidance alone without a snapshot, guidance then snapshot with one, and empty when off", () => {
    const kb = source({ snapshots: { tagged: SUMMARY } });

    expect(buildKnowledgeBaseSystemPrompt(kb, "untagged")).toBe(KNOWLEDGE_BASE_GUIDANCE);
    expect(buildKnowledgeBaseSystemPrompt(kb, "tagged")).toBe(
      `${KNOWLEDGE_BASE_GUIDANCE}\n\n${SUMMARY}`,
    );
    expect(buildKnowledgeBaseSystemPrompt(source({ enabled: false }), "tagged")).toBe("");
    expect(buildKnowledgeBaseSystemPrompt(null, "tagged")).toBe("");
  });
});

/** Stands in for refocus: adds a block to every prompt and records each settle. */
function recordingRefocus() {
  const settles: boolean[] = [];
  const intercept: PromptDispatchInterceptor = (_agentId, prompt) => ({
    prompt: appendRefocusToPrompt(prompt, "<refocus/>"),
    settle: (delivered) => settles.push(delivered),
  });
  return { intercept, settles };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function createScenario(provider: "copilot" | "codex") {
  const workdir = mkdtempSync(join(tmpdir(), "kb-first-prompt-"));
  const client = new ScriptedClient();
  const manager = new AgentManager({ clients: { [provider]: client }, logger: createTestLogger() });
  const refocus = recordingRefocus();
  const summarySettles: boolean[] = [];
  const snapshots: Record<string, string> = {};
  const firstPrompt = new KnowledgeBaseFirstPromptSummary({
    knowledgeBase: source({ snapshots }),
    getAgent: (agentId) => manager.getAgent(agentId),
    ignoresSystemPrompt: (id) => id === "copilot",
  });
  const agent = await manager.createAgent({ provider, cwd: workdir }, undefined, {
    workspaceId: undefined,
  });
  // The snapshot exists from create on (KnowledgeBaseService.resolveAtCreate).
  snapshots[agent.id] = SUMMARY;
  manager.setPromptDispatchInterceptor(
    composePromptDispatchInterceptors(
      [
        refocus.intercept,
        (agentId, prompt) => {
          const interception = firstPrompt.interceptPrompt(agentId, prompt);
          if (!interception) return null;
          return {
            prompt: interception.prompt,
            settle: (delivered) => {
              summarySettles.push(delivered);
              interception.settle(delivered);
            },
          };
        },
      ],
      createTestLogger(),
    ),
  );
  const session: ScriptedSession = client.sessions[0]!;
  cleanups.push(async () => {
    await manager.closeAgent(agent.id).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  });
  return {
    refocus,
    summarySettles,
    async send(prompt: string): Promise<string> {
      const before = session.prompts.length;
      await startAgentRun(manager, agent.id, prompt, createTestLogger());
      await vi.waitFor(() => {
        expect(session.prompts.length).toBe(before + 1);
        expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");
      });
      return session.prompts[before]!;
    },
  };
}

describe("the Copilot first-prompt summary, composed after refocus", () => {
  test("rides on the first prompt only, after refocus, and each settles on its own", async () => {
    const scenario = await createScenario("copilot");

    expect(await scenario.send("Kick off the checkout work.")).toBe(
      `Kick off the checkout work.\n\n<refocus/>\n\n${SUMMARY_BLOCK}`,
    );
    expect(await scenario.send("Keep going.")).toBe("Keep going.\n\n<refocus/>");
    expect(scenario.refocus.settles).toEqual([true, true]);
    expect(scenario.summarySettles).toEqual([true]);
  });

  test("is not added for a provider that reads the system prompt", async () => {
    const scenario = await createScenario("codex");

    expect(await scenario.send("Kick off the checkout work.")).toBe(
      "Kick off the checkout work.\n\n<refocus/>",
    );
  });
});

describe("KnowledgeBaseFirstPromptSummary", () => {
  function summaryFor(agent: { provider: string; lastUserMessageAt: Date | null } | null) {
    return new KnowledgeBaseFirstPromptSummary({
      knowledgeBase: source({ snapshots: { "agent-1": SUMMARY } }),
      getAgent: () => agent,
      ignoresSystemPrompt: (provider) => provider === "copilot",
    });
  }

  test("a dispatch that fails leaves the summary for the next prompt, and none is added while one is in flight", () => {
    const summary = summaryFor({ provider: "copilot", lastUserMessageAt: null });

    const first = summary.interceptPrompt("agent-1", "Kick off.");
    expect(first?.prompt).toBe(`Kick off.\n\n${SUMMARY_BLOCK}`);
    expect(summary.interceptPrompt("agent-1", "Also this.")).toBeNull();

    first?.settle(false);
    expect(summary.interceptPrompt("agent-1", "Kick off again.")?.prompt).toBe(
      `Kick off again.\n\n${SUMMARY_BLOCK}`,
    );
  });

  test("an agent that has had a prompt, as after a daemon restart, gets none", () => {
    const summary = summaryFor({ provider: "copilot", lastUserMessageAt: new Date(0) });

    expect(summary.interceptPrompt("agent-1", "Carry on.")).toBeNull();
  });

  test("waits past a slash command, which would read the summary as its arguments", () => {
    const summary = summaryFor({ provider: "copilot", lastUserMessageAt: null });

    expect(summary.interceptPrompt("agent-1", "/compact keep the plan")).toBeNull();
    expect(summary.interceptPrompt("agent-1", "Start.")?.prompt).toBe(`Start.\n\n${SUMMARY_BLOCK}`);
  });

  test("an agent with no snapshot, or with the knowledge base off, gets none", () => {
    const untagged = summaryFor({ provider: "copilot", lastUserMessageAt: null });
    const off = new KnowledgeBaseFirstPromptSummary({
      knowledgeBase: source({ enabled: false, snapshots: { "agent-1": SUMMARY } }),
      getAgent: () => ({ provider: "copilot", lastUserMessageAt: null }),
      ignoresSystemPrompt: () => true,
    });

    expect(untagged.interceptPrompt("agent-2", "Start.")).toBeNull();
    expect(off.interceptPrompt("agent-1", "Start.")).toBeNull();
  });
});

describe("composePromptDispatchInterceptors", () => {
  test("an interceptor or settle that throws does not stop the others", () => {
    const settles: string[] = [];
    const composed = composePromptDispatchInterceptors(
      [
        () => {
          throw new Error("refocus state is broken");
        },
        (_agentId, prompt) => ({
          prompt: appendRefocusToPrompt(prompt, "<a/>"),
          settle: () => {
            throw new Error("settle failed");
          },
        }),
        (_agentId, prompt) => ({
          prompt: appendRefocusToPrompt(prompt, "<b/>"),
          settle: (delivered) => settles.push(`b:${delivered}`),
        }),
      ],
      createTestLogger(),
    );

    const interception = composed("agent-1", "Hello.");
    interception?.settle(true);

    expect(interception?.prompt).toBe("Hello.\n\n<a/>\n\n<b/>");
    expect(settles).toEqual(["b:true"]);
  });

  test("returns null when no interceptor adds anything", () => {
    expect(
      composePromptDispatchInterceptors([() => null], createTestLogger())("a", "Hi"),
    ).toBeNull();
  });
});
