import { describe, expect, it } from "vitest";
import { AgentProviderMoveRejection } from "@getpaseo/client/internal/daemon-client";
import type { AgentProviderNotice } from "@getpaseo/protocol/agent-types";
import {
  applyAgentChanges,
  parseAgentChanges,
  toAgentUpdateResult,
  type AgentMetadataChanges,
  type AgentUpdateClient,
} from "./update.js";

class RecordingAgentUpdateClient implements AgentUpdateClient {
  readonly metadataUpdates: Array<{
    agentId: string;
    updates: AgentMetadataChanges;
  }> = [];
  readonly thinkingUpdates: Array<{ agentId: string; thinkingOptionId: string }> = [];
  readonly providerMoves: Array<{ agentId: string; providerId: string }> = [];
  thinkingNotice: AgentProviderNotice | null = null;
  providerMoveRejection: AgentProviderMoveRejection | null = null;

  constructor(
    private readonly supportsThinkingUpdate = true,
    private readonly supportsProviderMove = true,
  ) {}

  getLastServerInfoMessage() {
    return {
      features: {
        agentThinkingUpdate: this.supportsThinkingUpdate,
        agentProviderMove: this.supportsProviderMove,
      },
    };
  }

  async moveAgentToProvider(agentId: string, providerId: string): Promise<void> {
    if (this.providerMoveRejection) {
      throw this.providerMoveRejection;
    }
    this.providerMoves.push({ agentId, providerId });
  }

  async updateAgent(agentId: string, updates: AgentMetadataChanges): Promise<void> {
    this.metadataUpdates.push({ agentId, updates });
  }

  async setAgentThinkingOption(
    agentId: string,
    thinkingOptionId: string,
  ): Promise<AgentProviderNotice | null> {
    this.thinkingUpdates.push({ agentId, thinkingOptionId });
    return this.thinkingNotice;
  }
}

describe("applyAgentChanges", () => {
  it("updates an agent's thinking without issuing an empty metadata update", async () => {
    const client = new RecordingAgentUpdateClient();

    const result = await applyAgentChanges(client, "agent-1", {
      type: "thinking",
      thinkingOptionId: "high",
    });

    expect(client.metadataUpdates).toEqual([]);
    expect(client.thinkingUpdates).toEqual([{ agentId: "agent-1", thinkingOptionId: "high" }]);
    expect(result).toEqual({
      notice: null,
    });
  });

  it("requires a daemon that advertises thinking updates", async () => {
    const client = new RecordingAgentUpdateClient(false);

    await expect(
      applyAgentChanges(client, "agent-1", { type: "thinking", thinkingOptionId: "high" }),
    ).rejects.toMatchObject({
      code: "DAEMON_UPDATE_REQUIRED",
      message: "Update the host to use agent thinking updates.",
    });
    expect(client.metadataUpdates).toEqual([]);
    expect(client.thinkingUpdates).toEqual([]);
  });

  it("returns the provider notice from a thinking update", async () => {
    const client = new RecordingAgentUpdateClient();
    client.thinkingNotice = {
      type: "warning",
      message: "Thinking changes apply to the next turn.",
    };

    const notice = await applyAgentChanges(client, "agent-1", {
      type: "thinking",
      thinkingOptionId: "high",
    });

    expect(notice).toEqual({
      notice: {
        type: "warning",
        message: "Thinking changes apply to the next turn.",
      },
    });
  });
});

describe("applyAgentChanges with --provider", () => {
  it("moves the agent and touches nothing else", async () => {
    const client = new RecordingAgentUpdateClient();

    const result = await applyAgentChanges(client, "agent-1", {
      type: "provider",
      providerId: "claude-backup",
    });

    expect(client.providerMoves).toEqual([{ agentId: "agent-1", providerId: "claude-backup" }]);
    expect(client.metadataUpdates).toEqual([]);
    expect(client.thinkingUpdates).toEqual([]);
    expect(result).toEqual({ notice: null });
  });

  it("requires a daemon that advertises provider moves", async () => {
    const client = new RecordingAgentUpdateClient(true, false);

    await expect(
      applyAgentChanges(client, "agent-1", { type: "provider", providerId: "claude-backup" }),
    ).rejects.toMatchObject({
      code: "DAEMON_UPDATE_REQUIRED",
      message: "Update the host to move an agent to another provider.",
    });
    expect(client.providerMoves).toEqual([]);
  });

  it("passes the daemon's refusal through so the operator can act on it", async () => {
    const client = new RecordingAgentUpdateClient();
    client.providerMoveRejection = new AgentProviderMoveRejection(
      "incompatible_provider",
      "Agent agent-1 runs a 'claude' session and 'codex' runs 'codex' sessions.",
    );

    await expect(
      applyAgentChanges(client, "agent-1", { type: "provider", providerId: "codex" }),
    ).rejects.toMatchObject({
      code: "INCOMPATIBLE_PROVIDER",
      message: "Agent agent-1 runs a 'claude' session and 'codex' runs 'codex' sessions.",
      details: "Agent agent-1 is still on its previous provider.",
    });
  });
});

describe("parseAgentChanges", () => {
  it("reads --provider as a provider move", () => {
    expect(parseAgentChanges({ provider: "claude-backup" })).toEqual({
      type: "provider",
      providerId: "claude-backup",
    });
  });

  it("refuses to mix a provider move with metadata or thinking in one command", () => {
    expect(() => parseAgentChanges({ provider: "claude-backup", name: "Renamed" })).toThrow();
    expect(() => parseAgentChanges({ provider: "claude-backup", thinking: "high" })).toThrow();
  });

  it("names --provider among the things there is to update", () => {
    expect(() => parseAgentChanges({})).toThrowError(
      expect.objectContaining({ code: "NO_CHANGES_PROVIDED" }),
    );
  });
});

describe("toAgentUpdateResult", () => {
  it("reports the current thinking option after a metadata update", () => {
    const result = toAgentUpdateResult(
      {
        id: "agent-1",
        title: "Renamed agent",
        provider: "claude-personal",
        labels: { team: "platform" },
        effectiveThinkingOptionId: "high",
      },
      { notice: null },
    );

    expect(result).toEqual({
      agentId: "agent-1",
      name: "Renamed agent",
      provider: "claude-personal",
      labels: "team=platform",
      thinkingOptionId: "high",
      noticeType: null,
      notice: null,
    });
  });
});
