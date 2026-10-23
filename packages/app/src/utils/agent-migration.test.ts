import { describe, expect, it } from "vitest";
import { ACCOUNT_FAILOVER_MIGRATED_TO_LABEL } from "@getpaseo/protocol/agent-labels";
import { decideAgentMoveNotice, heldAgentLookup, resolveShownAgent } from "@/utils/agent-migration";

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

describe("decideAgentMoveNotice", () => {
  const entries = [
    {
      provider: "claude-backup",
      label: "Claude Backup (work)",
      status: "ready" as const,
      enabled: true,
    },
  ];
  const notice = { id: 7, serverId: "server-a", agentId: "b" };
  const ready = {
    notice,
    shownNoticeId: null,
    agent: { provider: "claude-backup" },
    providerEntries: entries,
    providersLoading: false,
  };

  it("names the account the successor runs on", () => {
    expect(decideAgentMoveNotice(ready)).toEqual({
      kind: "show",
      noticeId: 7,
      target: { kind: "account", label: "Claude Backup (work)" },
    });
  });

  it("waits for the account labels while they load", () => {
    expect(
      decideAgentMoveNotice({ ...ready, providerEntries: undefined, providersLoading: true }),
    ).toEqual({ kind: "wait" });
  });

  it("falls back to the provider id when the host has no provider list", () => {
    expect(
      decideAgentMoveNotice({ ...ready, providerEntries: undefined, providersLoading: false }),
    ).toEqual({ kind: "show", noticeId: 7, target: { kind: "account", label: "claude-backup" } });
  });

  it("names the agent id without waiting when the app does not hold the successor", () => {
    expect(
      decideAgentMoveNotice({
        ...ready,
        agent: null,
        providerEntries: undefined,
        providersLoading: true,
      }),
    ).toEqual({ kind: "show", noticeId: 7, target: { kind: "agent", agentId: "b" } });
  });

  it("shows each notice once", () => {
    expect(decideAgentMoveNotice({ ...ready, shownNoticeId: 7 })).toEqual({ kind: "none" });
  });

  it("does nothing without a notice", () => {
    expect(decideAgentMoveNotice({ ...ready, notice: null })).toEqual({ kind: "none" });
  });
});
