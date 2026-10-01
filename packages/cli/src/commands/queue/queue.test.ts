import { describe, expect, it } from "vitest";
import type { WorkItem } from "@getpaseo/protocol/coordination/queue-schemas";
import { createQueueCommand } from "./index.js";
import {
  parseClosureOption,
  queueBlock,
  queueClaim,
  queueCreate,
  queueDone,
  queueHandoff,
  queueList,
  queueListSchema,
  queueShow,
  renderQueueShow,
  renderQueueWrite,
  resolveQueueActor,
  type QueueClient,
} from "./queue.js";

const AT = "2026-09-30T12:00:00.000Z";

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "wi-1",
    title: "Review the plan",
    owner: "agent-a",
    state: "pending",
    delivery: { state: "delivered", at: AT },
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

interface Call {
  method: string;
  input: unknown;
}

function fakeClient(responses: Partial<Record<keyof QueueClient, unknown>>): {
  client: QueueClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const method =
    (name: keyof QueueClient) =>
    async (input: unknown): Promise<unknown> => {
      calls.push({ method: name, input });
      return responses[name];
    };
  const client = {
    coordinationQueueCreate: method("coordinationQueueCreate"),
    coordinationQueueClaim: method("coordinationQueueClaim"),
    coordinationQueueTransition: method("coordinationQueueTransition"),
    coordinationQueueHandoff: method("coordinationQueueHandoff"),
    coordinationQueueList: method("coordinationQueueList"),
    coordinationQueueShow: method("coordinationQueueShow"),
    getLastServerInfoMessage: () => null,
  } as unknown as QueueClient;
  return { client, calls };
}

describe("paseo queue", () => {
  it("registers ls, show, create, claim, done, block and handoff, each with --json", () => {
    const queue = createQueueCommand();
    const names = queue.commands.map((command) => command.name());
    expect(names).toEqual(["ls", "show", "create", "claim", "done", "block", "handoff"]);
    for (const command of queue.commands) {
      expect(command.helpInformation()).toContain("--json");
    }
  });

  it("acts as --as, else PASEO_AGENT_ID, else human", () => {
    expect(resolveQueueActor({ as: "agent-x" }, { PASEO_AGENT_ID: "agent-y" })).toBe("agent-x");
    expect(resolveQueueActor({}, { PASEO_AGENT_ID: "agent-y" })).toBe("agent-y");
    expect(resolveQueueActor({}, {})).toBe("human");
  });

  it("parses --closure with the marker grammar and rejects an unknown reason", () => {
    expect(parseClosureOption("no-follow-on")).toEqual({ reason: "no-follow-on" });
    expect(parseClosureOption("handed_off_to=agent-b")).toEqual({
      reason: "handed_off_to",
      target: "agent-b",
    });
    expect(() => parseClosureOption("finished")).toThrow(
      expect.objectContaining({ code: "INVALID_CLOSURE" }),
    );
  });

  it("create says what happened, the state now and the next action", async () => {
    const { client, calls } = fakeClient({
      coordinationQueueCreate: { requestId: "r", item: item(), changed: true },
    });
    const result = await queueCreate(client, { title: "Review the plan", owner: "agent-a" }, "human");
    expect(calls).toEqual([
      {
        method: "coordinationQueueCreate",
        input: { title: "Review the plan", owner: "agent-a", actor: "human" },
      },
    ]);
    expect(renderQueueWrite(result)).toBe(
      [
        'Created wi-1 "Review the plan".',
        "State: pending · owner agent-a · delivery delivered",
        "Next: waiting for agent-a to claim it; `paseo queue show wi-1` to check.",
      ].join("\n"),
    );
  });

  it("claim, done and block send the right transition and point at the next step", async () => {
    const claimed = await queueClaim(
      fakeClient({
        coordinationQueueClaim: { requestId: "r", item: item({ state: "in-progress" }), changed: false },
      }).client,
      "wi-1",
      "agent-a",
    );
    expect(renderQueueWrite(claimed)).toContain("(no change; it already was)");
    expect(claimed.next).toContain("paseo queue done wi-1 --closure no-follow-on");

    const done = fakeClient({
      coordinationQueueTransition: {
        requestId: "r",
        item: item({ state: "done", closure: { reason: "no-follow-on" } }),
        changed: true,
      },
    });
    const closed = await queueDone(
      done.client,
      { id: "wi-1", closure: { reason: "no-follow-on" } },
      "agent-a",
    );
    expect(done.calls[0].input).toEqual({
      id: "wi-1",
      to: "done",
      closure: { reason: "no-follow-on" },
      actor: "agent-a",
    });
    expect(renderQueueWrite(closed)).toContain("State: done · owner agent-a · no-follow-on");

    const block = fakeClient({
      coordinationQueueTransition: {
        requestId: "r",
        item: item({ state: "blocked", closure: { reason: "blocked_on", target: "wi-9" } }),
      },
    });
    await queueBlock(block.client, { id: "wi-1", on: "wi-9" }, "agent-a");
    expect(block.calls[0].input).toMatchObject({
      to: "blocked",
      closure: { reason: "blocked_on", target: "wi-9" },
    });
  });

  it("handoff reports the successor and its next step", async () => {
    const { client } = fakeClient({
      coordinationQueueHandoff: {
        requestId: "r",
        item: item({ state: "handed-off", handedOffTo: "wi_succ" }),
        successor: item({ id: "wi_succ", owner: "agent-b", handedOffFrom: "wi-1" }),
        changed: true,
      },
    });
    const result = await queueHandoff(client, { id: "wi-1", to: "agent-b" }, "agent-a");
    expect(renderQueueWrite(result)).toBe(
      [
        'Handed off wi-1 "Review the plan".',
        "Successor: wi_succ, owner agent-b.",
        "State: pending · owner agent-b · delivery delivered",
        "Next: waiting for agent-b to claim it; `paseo queue show wi_succ` to check.",
      ].join("\n"),
    );
  });

  it("turns a daemon error into a command error carrying the daemon's explanation", async () => {
    const { client } = fakeClient({
      coordinationQueueTransition: {
        requestId: "r",
        error: "Finishing as done needs a closure reason.",
        errorCode: "invalid",
      },
    });
    await expect(queueDone(client, { id: "wi-1" }, "agent-a")).rejects.toEqual({
      code: "QUEUE_INVALID",
      message: "Finishing as done needs a closure reason.",
    });
  });

  it("ls asks for open items by default and keeps JSON compact unless --full", async () => {
    const { client, calls } = fakeClient({
      coordinationQueueList: { requestId: "r", items: [item()] },
    });
    const rows = await queueList(client, { owner: "agent-a" });
    expect(calls[0].input).toEqual({ filter: { owner: "agent-a", openOnly: true } });
    expect(queueListSchema(false).serialize?.(rows[0])).toEqual({
      id: "wi-1",
      state: "pending",
      owner: "agent-a",
      title: "Review the plan",
      closure: "",
    });
    expect(queueListSchema(true).serialize?.(rows[0])).toEqual(item());
  });

  it("show prints the item and only the last five transitions unless --full", async () => {
    const transitions = Array.from({ length: 7 }, (_, index) => ({
      seq: index + 1,
      itemId: "wi-1",
      to: "in-progress" as const,
      at: `2026-09-30T12:0${index}:00.000Z`,
      actor: "agent-a",
    }));
    const { client } = fakeClient({
      coordinationQueueShow: { requestId: "r", item: item(), transitions },
    });
    const compact = renderQueueShow(await queueShow(client, "wi-1", false));
    expect(compact.split("\n").filter((line) => line.includes("→"))).toHaveLength(5);
    const full = renderQueueShow(await queueShow(client, "wi-1", true));
    expect(full.split("\n").filter((line) => line.includes("→"))).toHaveLength(7);
  });
});
