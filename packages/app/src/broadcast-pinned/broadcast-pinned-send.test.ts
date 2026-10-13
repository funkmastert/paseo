import { describe, expect, it, vi } from "vitest";
import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages";
import type { ComposerSendClient, MessageSubmissionWriter } from "@/composer/actions";
import { sendBroadcastPinnedPrompt } from "./broadcast-pinned-send";
import type { BroadcastPinnedTarget } from "./broadcast-pinned-targets";

function target(input: Partial<BroadcastPinnedTarget> & { id: string }): BroadcastPinnedTarget {
  return {
    serverId: "host-1",
    workspaceId: "ws-1",
    workspaceName: "Chat",
    label: "Leader",
    status: "idle",
    ...input,
  };
}

function noopSubmission(): MessageSubmissionWriter {
  return { begin: () => undefined, accept: () => undefined, reject: () => "unknown" };
}

const DEFAULT_ACTIVE_TURN = { behavior: "interrupt" as ActiveTurnBehavior };

describe("sendBroadcastPinnedPrompt", () => {
  it("resolves immediately with no targets, without calling any client", async () => {
    const getClient = vi.fn();
    const result = await sendBroadcastPinnedPrompt({
      targets: [],
      text: "hello",
      getClient,
      resolveActiveTurn: () => DEFAULT_ACTIVE_TURN,
      makeSubmission: noopSubmission,
    });
    expect(result).toEqual({ succeeded: [], failed: [] });
    expect(getClient).not.toHaveBeenCalled();
  });

  it("sends to every target and reports them all as succeeded", async () => {
    const sendAgentMessage = vi.fn().mockResolvedValue(undefined);
    const client: ComposerSendClient = { sendAgentMessage, uploadFile: vi.fn() };
    const targets = [target({ id: "a1" }), target({ id: "a2" })];

    const result = await sendBroadcastPinnedPrompt({
      targets,
      text: "status please",
      getClient: () => client,
      resolveActiveTurn: () => DEFAULT_ACTIVE_TURN,
      makeSubmission: noopSubmission,
    });

    expect(result.succeeded.sort()).toEqual(["a1", "a2"]);
    expect(result.failed).toEqual([]);
    expect(sendAgentMessage).toHaveBeenCalledTimes(2);
  });

  it("keeps the other targets succeeding when one target's send rejects", async () => {
    const sendAgentMessage = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error("boom")))
      .mockImplementationOnce(() => Promise.resolve(undefined));
    const client: ComposerSendClient = { sendAgentMessage, uploadFile: vi.fn() };
    const targets = [target({ id: "fails" }), target({ id: "succeeds" })];

    const result = await sendBroadcastPinnedPrompt({
      targets,
      text: "status please",
      getClient: () => client,
      resolveActiveTurn: () => DEFAULT_ACTIVE_TURN,
      makeSubmission: noopSubmission,
    });

    expect(result.succeeded).toEqual(["succeeds"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.target.id).toBe("fails");
    expect(result.failed[0]?.error).toBe("boom");
  });

  it("counts a target as failed, not thrown, when its host has no client", async () => {
    const result = await sendBroadcastPinnedPrompt({
      targets: [target({ id: "disconnected" })],
      text: "status please",
      getClient: () => null,
      resolveActiveTurn: () => DEFAULT_ACTIVE_TURN,
      makeSubmission: noopSubmission,
    });

    expect(result.succeeded).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.target.id).toBe("disconnected");
  });

  it("dispatches concurrently rather than one at a time", async () => {
    const deferred: { resolveFirst: (() => void) | null } = { resolveFirst: null };
    const started: string[] = [];
    const sendAgentMessage = vi.fn().mockImplementation((agentId: string) => {
      started.push(agentId);
      if (agentId === "a1") {
        return new Promise<void>((resolve) => {
          deferred.resolveFirst = resolve;
        });
      }
      return Promise.resolve(undefined);
    });
    const client: ComposerSendClient = { sendAgentMessage, uploadFile: vi.fn() };
    const targets = [target({ id: "a1" }), target({ id: "a2" })];

    const pending = sendBroadcastPinnedPrompt({
      targets,
      text: "status please",
      getClient: () => client,
      resolveActiveTurn: () => DEFAULT_ACTIVE_TURN,
      makeSubmission: noopSubmission,
    });

    // The second target's send is issued before the first target's promise ever resolves —
    // proof the fan-out is concurrent, not sequential.
    await vi.waitFor(() => expect(started).toContain("a2"));
    expect(deferred.resolveFirst).not.toBeNull();
    deferred.resolveFirst?.();

    const result = await pending;
    expect(result.succeeded.sort()).toEqual(["a1", "a2"]);
  });

  it("passes the resolved activeTurnBehavior and activeTurnId through per target", async () => {
    const sendAgentMessage = vi.fn().mockResolvedValue(undefined);
    const client: ComposerSendClient = { sendAgentMessage, uploadFile: vi.fn() };
    const targets = [target({ id: "steering" }), target({ id: "idle-agent" })];

    await sendBroadcastPinnedPrompt({
      targets,
      text: "status please",
      getClient: () => client,
      resolveActiveTurn: (t) =>
        t.id === "steering" ? { behavior: "steer", turnId: "turn-123" } : { behavior: "interrupt" },
      makeSubmission: noopSubmission,
    });

    expect(sendAgentMessage).toHaveBeenCalledWith(
      "steering",
      "status please",
      expect.objectContaining({ activeTurnBehavior: "steer" }),
    );
    expect(sendAgentMessage).toHaveBeenCalledWith(
      "idle-agent",
      "status please",
      expect.objectContaining({ activeTurnBehavior: "interrupt" }),
    );
  });

  it("queues a target locally instead of dispatching, when shouldQueueLocally says so", async () => {
    const sendAgentMessage = vi.fn().mockResolvedValue(undefined);
    const client: ComposerSendClient = { sendAgentMessage, uploadFile: vi.fn() };
    const queueLocally = vi.fn();
    const targets = [target({ id: "queued" }), target({ id: "dispatched" })];

    const result = await sendBroadcastPinnedPrompt({
      targets,
      text: "status please",
      getClient: () => client,
      resolveActiveTurn: () => DEFAULT_ACTIVE_TURN,
      makeSubmission: noopSubmission,
      shouldQueueLocally: (t) => t.id === "queued",
      queueLocally,
    });

    expect(queueLocally).toHaveBeenCalledTimes(1);
    expect(queueLocally).toHaveBeenCalledWith(expect.objectContaining({ id: "queued" }));
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    expect(sendAgentMessage).toHaveBeenCalledWith("dispatched", "status please", expect.anything());
    expect(result.succeeded.sort()).toEqual(["dispatched", "queued"]);
    expect(result.failed).toEqual([]);
  });
});
