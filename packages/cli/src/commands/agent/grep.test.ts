import { describe, expect, it, vi } from "vitest";
import { runGrepCommand } from "./grep.js";

const agent = { id: "11111111-1111-4111-8111-111111111111" };
const searchAgentTranscript = vi.fn();
const close = vi.fn(async () => undefined);
const getLastServerInfoMessage = vi.fn(() => ({
  features: { agentTranscriptSearch: true },
}));

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    fetchAgent: vi.fn(async () => ({ agent })),
    searchAgentTranscript,
    getLastServerInfoMessage,
    close,
  })),
  getDaemonHost: vi.fn(() => "ws://127.0.0.1:6767"),
}));

describe("runGrepCommand", () => {
  it("flattens agent excerpts into rows and resolves an id prefix", async () => {
    searchAgentTranscript.mockResolvedValueOnce({
      backend: "node",
      targetSetTruncated: false,
      error: null,
      agents: [
        {
          agentId: agent.id,
          title: "Leader",
          provider: "claude",
          coverage: "searched",
          matchCount: 1,
          excerpts: [{ lineNumber: 3, role: "user", text: "found the auth bug" }],
        },
      ],
    });

    const result = await runGrepCommand("1111", "auth bug", {}, {} as never);

    expect(searchAgentTranscript).toHaveBeenCalledWith(agent.id, "auth bug", {
      tree: undefined,
      regex: undefined,
      caseInsensitive: undefined,
      full: undefined,
    });
    expect(result.data).toEqual([
      {
        agentId: agent.id,
        title: "Leader",
        coverage: "searched",
        line: 3,
        role: "user",
        text: "found the auth bug",
      },
    ]);
  });

  it("emits a placeholder row naming the coverage reason when an agent has no excerpts", async () => {
    searchAgentTranscript.mockResolvedValueOnce({
      backend: "node",
      targetSetTruncated: false,
      error: null,
      agents: [
        {
          agentId: agent.id,
          title: null,
          provider: "claude",
          coverage: "not_found",
          matchCount: 0,
          excerpts: [],
        },
      ],
    });

    const result = await runGrepCommand(agent.id, "pattern", {}, {} as never);

    expect(result.data).toEqual([
      {
        agentId: agent.id,
        title: null,
        coverage: "not_found",
        line: null,
        role: null,
        text: "(no excerpts — coverage: not_found)",
      },
    ]);
  });

  it("passes tree/regex/ignoreCase/full through to the daemon call", async () => {
    searchAgentTranscript.mockResolvedValueOnce({
      backend: "ripgrep",
      targetSetTruncated: true,
      error: null,
      agents: [],
    });

    await runGrepCommand(
      agent.id,
      "fo+",
      { tree: true, regex: true, ignoreCase: true, full: true },
      {} as never,
    );

    expect(searchAgentTranscript).toHaveBeenCalledWith(agent.id, "fo+", {
      tree: true,
      regex: true,
      caseInsensitive: true,
      full: true,
    });
  });

  it("rejects when the daemon does not advertise the feature", async () => {
    getLastServerInfoMessage.mockReturnValueOnce({ features: {} });

    await expect(runGrepCommand(agent.id, "pattern", {}, {} as never)).rejects.toMatchObject({
      code: "UNSUPPORTED_DAEMON",
    });
  });

  it("surfaces a daemon-reported search error as a command error", async () => {
    searchAgentTranscript.mockResolvedValueOnce({
      backend: null,
      targetSetTruncated: false,
      error: "Agent xyz is not known to the daemon",
      agents: [],
    });

    await expect(runGrepCommand(agent.id, "pattern", {}, {} as never)).rejects.toMatchObject({
      code: "GREP_FAILED",
    });
  });
});
