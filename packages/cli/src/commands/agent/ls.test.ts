import { describe, expect, it } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { buildAgentLsFetchOptions, toListItem } from "./ls.js";

const BASE_AGENT: AgentSnapshotPayload = {
  id: "00000000-0000-4000-8000-000000000001",
  provider: "claude",
  cwd: "/tmp/project",
  model: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  lastUserMessageAt: null,
  status: "idle",
  capabilities: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  },
  currentModeId: null,
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  title: null,
  labels: {},
};

describe("toListItem", () => {
  it("carries archivedAt and labels through for --json output", () => {
    const item = toListItem({
      ...BASE_AGENT,
      archivedAt: "2026-01-02T00:00:00.000Z",
      labels: { "paseo.parentAgentId": "parent-1" },
    });

    expect(item.archivedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(item.labels).toEqual({ "paseo.parentAgentId": "parent-1" });
  });

  it("defaults archivedAt to null for an active agent", () => {
    const item = toListItem(BASE_AGENT);

    expect(item.archivedAt).toBeNull();
    expect(item.labels).toEqual({});
  });
});

describe("buildAgentLsFetchOptions", () => {
  it("fetches active agents by default", () => {
    expect(buildAgentLsFetchOptions({})).toEqual({
      scope: "active",
    });
  });

  it("keeps label and thinking filters within the active scope", () => {
    expect(
      buildAgentLsFetchOptions({
        label: ["surface=workspace"],
        thinking: " medium ",
      }),
    ).toEqual({
      scope: "active",
      filter: {
        labels: { surface: "workspace" },
        thinkingOptionId: "medium",
      },
    });
  });

  it("fetches global non-archived agents for -g", () => {
    expect(buildAgentLsFetchOptions({ global: true })).toEqual({});
  });

  it("keeps -a within the active scope", () => {
    expect(buildAgentLsFetchOptions({ all: true })).toEqual({
      scope: "active",
      filter: {
        includeArchived: true,
      },
    });
  });

  it("fetches all global agents for -a -g", () => {
    expect(buildAgentLsFetchOptions({ all: true, global: true })).toEqual({
      filter: {
        includeArchived: true,
      },
    });
  });

  it("applies filters to global queries", () => {
    expect(
      buildAgentLsFetchOptions({
        global: true,
        label: ["surface=workspace"],
        thinking: " medium ",
      }),
    ).toEqual({
      filter: {
        labels: { surface: "workspace" },
        thinkingOptionId: "medium",
      },
    });
  });
});
