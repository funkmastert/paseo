import { describe, expect, it } from "vitest";
import { sendAndMaybeWait, type AgentSendClient } from "./send.js";

type WaitState = Awaited<ReturnType<AgentSendClient["waitForFinish"]>>;

class RecordingSendClient implements AgentSendClient {
  readonly sent: string[] = [];
  readonly waited: string[] = [];

  constructor(private readonly deliveredToAgentId: string | null) {}

  async sendAgentMessage(agentId: string) {
    this.sent.push(agentId);
    return { agentId, deliveredToAgentId: this.deliveredToAgentId };
  }

  async waitForFinish(agentId: string): Promise<WaitState> {
    this.waited.push(agentId);
    return {
      status: "idle",
      final: null,
      error: null,
      lastMessage: null,
    } as unknown as WaitState;
  }
}

describe("send to an agent account failover moved", () => {
  it("waits on the agent the message was delivered to, and says it moved", async () => {
    const client = new RecordingSendClient("agent-successor");

    const result = await sendAndMaybeWait(client, "agent-retired", "pick it up", { wait: true });

    expect(client.sent).toEqual(["agent-retired"]);
    expect(client.waited).toEqual(["agent-successor"]);
    expect(result).toEqual({
      agentId: "agent-successor",
      status: "completed",
      message: "Delivered to agent-successor (moved). Agent completed processing the message",
    });
  });

  it("says where it went without waiting", async () => {
    const client = new RecordingSendClient("agent-successor");

    const result = await sendAndMaybeWait(client, "agent-retired", "pick it up", { wait: false });

    expect(client.waited).toEqual([]);
    expect(result).toEqual({
      agentId: "agent-successor",
      status: "sent",
      message: "Delivered to agent-successor (moved), not waiting for completion",
    });
  });

  it("reads as before for an agent that never moved", async () => {
    const client = new RecordingSendClient(null);

    const result = await sendAndMaybeWait(client, "agent-1", "hello", { wait: true });

    expect(client.waited).toEqual(["agent-1"]);
    expect(result).toEqual({
      agentId: "agent-1",
      status: "completed",
      message: "Agent completed processing the message",
    });
  });
});
