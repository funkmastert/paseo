import { describe, expect, test } from "vitest";
import type { AgentListItemPayload, AgentSnapshotPayload } from "../../messages.js";
import { addModelVisibleStructuredContent } from "./paseo-tool-serialization.js";
import { toCompactAgentListItem, toCompactAgentSnapshot } from "./tool-output-projection.js";

/**
 * A fleet shaped like the orchestration panel's fixture (53 agents: 4 running, 30 idle, 19
 * closed, most under a parent), with the labels a real daemon stamps on them.
 */
function fleet(): AgentListItemPayload[] {
  const statuses = [
    ...Array<"running">(4).fill("running"),
    ...Array<"idle">(30).fill("idle"),
    ...Array<"closed">(19).fill("closed"),
  ];
  return statuses.map((status, index) => {
    const id = `0199a3f2-${String(index).padStart(4, "0")}-7c1e-8b7a-3d5f9e2c1a4b`;
    const row: AgentListItemPayload = {
      id,
      shortId: id.slice(0, 7),
      title: `Implement feature ${index}: something descriptive enough`,
      provider: index % 3 === 0 ? "claude-personal" : "claude-work",
      model: "claude-sonnet-5",
      thinkingOptionId: "high",
      effectiveThinkingOptionId: "high",
      status,
      cwd: `/Users/dev/.paseo/worktrees/abcd1234/feature-${index}`,
      createdAt: "2026-09-23T10:11:12.123Z",
      updatedAt: "2026-09-23T11:12:13.456Z",
      lastUserMessageAt: "2026-09-23T10:11:12.123Z",
      archivedAt: null,
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      labels: {
        "paseo.parent-agent-id": "0199a3f2-0000-7c1e-8b7a-3d5f9e2c1a4b",
        "paseo.agent-type": "implementer",
        "paseo.task-class": "standard",
        "paseo.budget": "300000",
        "paseo.open-agent-tab.client-1": "true",
      },
    };
    if (status === "running") row.lastActivitySummary = "[Edit] packages/app/src/panel.tsx";
    return row;
  });
}

const visibleBytes = (structured: unknown) =>
  (
    addModelVisibleStructuredContent({ content: [], structuredContent: structured }).content[0]
      ?.text ?? ""
  ).length;

describe("list_agents projection", () => {
  test("a 53-agent fleet: the rows shrink by over a third, and the whole call by about half against the old output", () => {
    const rows = fleet();
    const fullRows = visibleBytes({ agents: rows });
    const compactRows = visibleBytes({ agents: rows.map(toCompactAgentListItem) });
    // What list_agents returned to the model before OR-H4: full rows, pretty-printed.
    const before = JSON.stringify({ agents: rows }, null, 2).length;

    expect(rows).toHaveLength(53);
    expect(compactRows).toBeLessThan(fullRows * 0.65);
    expect(compactRows).toBeLessThan(before * 0.55);
  });

  test("keeps what an orchestrator decides with", () => {
    const [running] = fleet();
    const compact = toCompactAgentListItem({
      ...running!,
      requiresAttention: true,
      attentionReason: "permission",
    });

    expect(compact).toMatchObject({
      id: running!.id,
      title: running!.title,
      provider: "claude-personal",
      model: "claude-sonnet-5",
      status: "running",
      cwd: running!.cwd,
      requiresAttention: true,
      attentionReason: "permission",
      lastActivitySummary: "[Edit] packages/app/src/panel.tsx",
    });
    expect(compact.labels).toEqual({
      "paseo.parent-agent-id": "0199a3f2-0000-7c1e-8b7a-3d5f9e2c1a4b",
      "paseo.agent-type": "implementer",
      "paseo.task-class": "standard",
      "paseo.budget": "300000",
    });
    expect(compact).not.toHaveProperty("shortId");
    expect(compact).not.toHaveProperty("createdAt");
    expect(compact).not.toHaveProperty("thinkingOptionId");
  });
});

describe("get_agent_status projection", () => {
  test("drops the provider resume handle, capabilities and mode catalogue", () => {
    const snapshot = {
      id: "a",
      status: "idle",
      labels: { "paseo.open-agent-tab.c": "true", keep: "me" },
      persistence: { provider: "claude", sessionId: "s", metadata: { blob: "x".repeat(4000) } },
      capabilities: { supportsStreaming: true },
      availableModes: [{ id: "default", label: "Default" }],
      mcpServerStatuses: [{ name: "paseo", status: "connected" }],
      pendingPermissions: [],
    } as unknown as AgentSnapshotPayload;

    const compact = toCompactAgentSnapshot(snapshot);

    expect(compact).toEqual({
      id: "a",
      status: "idle",
      labels: { keep: "me" },
      pendingPermissions: [],
    });
    expect(visibleBytes({ snapshot: compact })).toBeLessThan(visibleBytes({ snapshot }) / 10);
  });
});

describe("model-visible JSON", () => {
  test("is not indented", () => {
    const text = addModelVisibleStructuredContent({
      content: [],
      structuredContent: { a: { b: 1 } },
    }).content[0]?.text;

    expect(text).toBe('{"a":{"b":1}}');
  });
});
