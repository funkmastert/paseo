import { describe, expect, it } from "vitest";
import { ACCOUNT_FAILOVER_MIGRATED_TO_LABEL } from "@getpaseo/protocol/agent-labels";
import {
  heldAgentLookup,
  resolveAgentMoveNoteTarget,
  resolveShownAgent,
} from "@/utils/agent-migration";

function held(agents: Record<string, string | null>) {
  const byId = new Map(
    Object.entries(agents).map(([id, movedTo]) => [
      id,
      { labels: movedTo === null ? {} : { [ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]: movedTo } },
    ]),
  );
  return (agentId: string) => byId.get(agentId);
}

describe("resolveShownAgent", () => {
  it("shows an agent that never moved", () => {
    expect(resolveShownAgent("a", held({ a: null }))).toEqual({ kind: "self" });
  });

  it("shows an agent the app does not hold as itself", () => {
    expect(resolveShownAgent("missing", held({ a: null }))).toEqual({ kind: "self" });
  });

  it("reads a blank migrated-to as the live end (a revived handle)", () => {
    expect(resolveShownAgent("a", held({ a: "" }))).toEqual({ kind: "self" });
  });

  it("shows the live end of a chain the app holds", () => {
    expect(resolveShownAgent("a", held({ a: "b", b: "c", c: null }))).toEqual({
      kind: "moved",
      agentId: "c",
    });
  });

  it("stops at the last held hop when the chain runs past what the app holds", () => {
    expect(resolveShownAgent("a", held({ a: "b", b: "gone" }))).toEqual({
      kind: "moved",
      agentId: "b",
    });
  });

  it("keeps the handle and names the successor the app does not hold", () => {
    expect(resolveShownAgent("a", held({ a: "gone" }))).toEqual({
      kind: "stranded",
      movedToAgentId: "gone",
    });
  });

  it("keeps the handle on a loop and names its first hop", () => {
    expect(resolveShownAgent("a", held({ a: "b", b: "a" }))).toEqual({
      kind: "stranded",
      movedToAgentId: "b",
    });
  });
});

describe("heldAgentLookup", () => {
  it("prefers the live agent list over fetched details", () => {
    interface Held {
      id: string;
      labels: Record<string, string>;
    }
    const live: Held = { id: "a", labels: { k: "live" } };
    const detail: Held = { id: "a", labels: { k: "detail" } };
    const lookup = heldAgentLookup({
      agents: new Map([["a", live]]),
      agentDetails: new Map<string, Held>([
        ["a", detail],
        ["b", { id: "b", labels: {} }],
      ]),
    });
    expect(lookup("a")).toBe(live);
    expect(lookup("b")?.id).toBe("b");
    expect(lookup("c")).toBeUndefined();
  });

  it("holds nothing for a host without a session", () => {
    expect(heldAgentLookup(undefined)("a")).toBeUndefined();
  });
});

describe("resolveAgentMoveNoteTarget", () => {
  const entries = [
    {
      provider: "claude-backup",
      label: "Claude Backup (work)",
      status: "ready" as const,
      enabled: true,
    },
  ];

  it("names the account the successor runs on", () => {
    expect(
      resolveAgentMoveNoteTarget({
        agentId: "b",
        agent: { provider: "claude-backup" },
        providerEntries: entries,
      }),
    ).toEqual({ kind: "account", label: "Claude Backup (work)" });
  });

  it("falls back to the provider id before the provider list arrives", () => {
    expect(
      resolveAgentMoveNoteTarget({
        agentId: "b",
        agent: { provider: "claude-backup" },
        providerEntries: undefined,
      }),
    ).toEqual({ kind: "account", label: "claude-backup" });
  });

  it("names the agent id when the app does not hold the successor", () => {
    expect(
      resolveAgentMoveNoteTarget({ agentId: "gone", agent: undefined, providerEntries: entries }),
    ).toEqual({ kind: "agent", agentId: "gone" });
  });
});
