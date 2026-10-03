import { describe, expect, it } from "vitest";
import type { AgentAccountAuth } from "./agent-sdk-types.js";
import {
  pickFailoverTarget,
  providersShareAccount,
  resolveAccountPoolEntries,
} from "./account-pool-providers.js";

describe("resolveAccountPoolEntries", () => {
  it("resolves the bare 'claude' id and extends:'claude' entries with accountPool params", () => {
    const entries = resolveAccountPoolEntries({
      claude: { params: { accountPool: { role: "leader", priority: 1 } } },
      "claude-personal": {
        extends: "claude",
        label: "Personal",
        params: { accountPool: { role: "worker", priority: 1 } },
      },
      "claude-backup": {
        extends: "claude",
        label: "Backup",
        params: { accountPool: { role: "worker", priority: 2 } },
      },
    });

    expect(entries).toEqual(
      expect.arrayContaining([
        { providerId: "claude", role: "leader", priority: 1, enabled: true },
        { providerId: "claude-personal", role: "worker", priority: 1, enabled: true },
        { providerId: "claude-backup", role: "worker", priority: 2, enabled: true },
      ]),
    );
    expect(entries).toHaveLength(3);
  });

  it("makes the bare claude entry the leader when the pool names no leader", () => {
    const entries = resolveAccountPoolEntries({
      "claude-personal": {
        extends: "claude",
        label: "Personal",
        params: { accountPool: { role: "worker", priority: 1 } },
      },
    });

    expect(entries).toEqual([
      { providerId: "claude-personal", role: "worker", priority: 1, enabled: true },
      { providerId: "claude", role: "leader", priority: 0, enabled: true },
    ]);
  });

  it("keeps a disabled claude entry disabled when it becomes the default leader", () => {
    const entries = resolveAccountPoolEntries({
      claude: { enabled: false },
      "claude-personal": {
        extends: "claude",
        label: "Personal",
        params: { accountPool: { role: "worker", priority: 1 } },
      },
    });

    expect(entries).toContainEqual({
      providerId: "claude",
      role: "leader",
      priority: 0,
      enabled: false,
    });
  });

  it("ignores non-claude-family providers even with accountPool-shaped params", () => {
    const entries = resolveAccountPoolEntries({
      codex: { params: { accountPool: { role: "worker", priority: 1 } } },
      "my-proxy": {
        extends: "acp",
        label: "Proxy",
        command: ["proxy"],
        params: { accountPool: { role: "worker", priority: 1 } },
      },
    });
    expect(entries).toEqual([]);
  });

  it("skips entries with no accountPool, or a malformed one", () => {
    const entries = resolveAccountPoolEntries({
      claude: {},
      "claude-a": { extends: "claude", label: "A", params: {} },
      "claude-b": { extends: "claude", label: "B", params: { accountPool: { role: "worker" } } },
      "claude-c": {
        extends: "claude",
        label: "C",
        params: { accountPool: { role: "not-a-role", priority: 1 } },
      },
      "claude-d": {
        extends: "claude",
        label: "D",
        params: { accountPool: { role: "worker", priority: "not-a-number" } },
      },
    });
    expect(entries).toEqual([]);
  });

  it("carries enabled:false through so callers can exclude it explicitly", () => {
    const entries = resolveAccountPoolEntries({
      "claude-w1": {
        extends: "claude",
        label: "W1",
        enabled: false,
        params: { accountPool: { role: "worker", priority: 1 } },
      },
    });
    expect(entries).toContainEqual({
      providerId: "claude-w1",
      role: "worker",
      priority: 1,
      enabled: false,
    });
  });

  it("returns an empty array when providers is undefined", () => {
    expect(resolveAccountPoolEntries(undefined)).toEqual([]);
  });
});

describe("pickFailoverTarget", () => {
  const entries = [
    { providerId: "claude", role: "leader" as const, priority: 1, enabled: true },
    { providerId: "claude-w2", role: "worker" as const, priority: 2, enabled: true },
    { providerId: "claude-w1b", role: "worker" as const, priority: 1, enabled: true },
    { providerId: "claude-w1a", role: "worker" as const, priority: 1, enabled: true },
    { providerId: "claude-w0", role: "worker" as const, priority: 0, enabled: false },
  ];
  const none = new Set<string>();

  it("picks the lowest priority number, breaking ties by provider id", () => {
    expect(pickFailoverTarget(entries, { deadProviderIds: none, sourceProviderId: "claude" })).toBe(
      "claude-w1a",
    );
  });

  it("skips dead workers and advances down the chain", () => {
    expect(
      pickFailoverTarget(entries, {
        deadProviderIds: new Set(["claude-w1a", "claude-w1b"]),
        sourceProviderId: "claude",
      }),
    ).toBe("claude-w2");
  });

  it("never picks the account the agent is leaving, even if it is not marked dead", () => {
    expect(
      pickFailoverTarget(entries, { deadProviderIds: none, sourceProviderId: "claude-w1a" }),
    ).toBe("claude-w1b");
  });

  it("never picks a disabled worker", () => {
    expect(
      pickFailoverTarget(entries, { deadProviderIds: none, sourceProviderId: "claude" }),
    ).not.toBe("claude-w0");
  });

  it("falls back to the leader account once no worker can take the agent", () => {
    // Isolation is a preference: a leader stranded on a dead account is worse than one sharing
    // the leader account with children.
    expect(
      pickFailoverTarget(entries, {
        deadProviderIds: new Set(["claude-w1a", "claude-w1b", "claude-w2"]),
        sourceProviderId: "claude-w2",
      }),
    ).toBe("claude");
  });

  it("keeps a worker ahead of the leader even when the leader has far more budget left", () => {
    expect(
      pickFailoverTarget(entries, {
        deadProviderIds: none,
        sourceProviderId: "claude-w2",
        headroom: new Map([
          ["claude", 95],
          ["claude-w1a", 8],
          ["claude-w1b", 8],
        ]),
      }),
    ).toBe("claude-w1a");
  });

  it("strands the agent rather than using the leader when collapse is switched off", () => {
    expect(
      pickFailoverTarget(entries, {
        deadProviderIds: new Set(["claude-w1a", "claude-w1b", "claude-w2"]),
        sourceProviderId: "claude-w2",
        allowLeader: false,
      }),
    ).toBeNull();
  });

  it("prefers the worker with the most budget left over the lowest priority number", () => {
    expect(
      pickFailoverTarget(entries, {
        deadProviderIds: none,
        sourceProviderId: "claude",
        // claude-w2 is last by priority and the only one with room.
        headroom: new Map([
          ["claude-w1a", 4],
          ["claude-w1b", 6],
          ["claude-w2", 71],
        ]),
      }),
    ).toBe("claude-w2");
  });

  it("falls back to priority order when headroom is empty — an unreadable usage poll changes nothing", () => {
    expect(
      pickFailoverTarget(entries, {
        deadProviderIds: none,
        sourceProviderId: "claude",
        headroom: new Map(),
      }),
    ).toBe("claude-w1a");
  });

  it("treats a provider missing from the headroom map as full, not as worst", () => {
    // A provider the usage poll never covered must not be demoted below a nearly-capped one.
    expect(
      pickFailoverTarget(entries, {
        deadProviderIds: none,
        sourceProviderId: "claude",
        headroom: new Map([
          ["claude-w1a", 3],
          ["claude-w1b", 3],
        ]),
      }),
    ).toBe("claude-w2");
  });

  it("puts a root on the leader account first, whatever the workers have left", () => {
    // A root is Tyler's own session. The leader account is where it belongs, and the one account
    // it is never kept off for isolation's sake.
    expect(
      pickFailoverTarget(entries, {
        deadProviderIds: none,
        sourceProviderId: "claude-w2",
        preferLeader: true,
        headroom: new Map([
          ["claude", 10],
          ["claude-w1a", 95],
        ]),
      }),
    ).toBe("claude");
  });

  it("sends a root to the worker with the most budget when the leader account is out", () => {
    expect(
      pickFailoverTarget(entries, {
        deadProviderIds: new Set(["claude"]),
        sourceProviderId: "claude-w2",
        preferLeader: true,
        headroom: new Map([
          ["claude-w1a", 5],
          ["claude-w1b", 60],
        ]),
      }),
    ).toBe("claude-w1b");
  });

  it("lets a root onto the leader account even with collapse switched off", () => {
    expect(
      pickFailoverTarget(entries, {
        deadProviderIds: none,
        sourceProviderId: "claude-w2",
        preferLeader: true,
        allowLeader: false,
      }),
    ).toBe("claude");
  });

  it("returns null when every account including the leader is dead", () => {
    expect(
      pickFailoverTarget(entries, {
        deadProviderIds: new Set(["claude", "claude-w1a", "claude-w1b", "claude-w2"]),
        sourceProviderId: "claude-w2",
      }),
    ).toBeNull();
  });

  it("returns null for an empty pool", () => {
    expect(
      pickFailoverTarget([], { deadProviderIds: none, sourceProviderId: "claude" }),
    ).toBeNull();
  });
});

describe("providersShareAccount", () => {
  it("matches only on an equal, readable account", () => {
    const tyler: AgentAccountAuth = { state: "signed-in", accountLabel: "tyler@example.com" };
    expect(providersShareAccount(tyler, { ...tyler })).toBe(true);
    expect(
      providersShareAccount(tyler, { state: "signed-in", accountLabel: "worker@example.com" }),
    ).toBe(false);
    // Two shrugs are not a match: "cannot tell" must never be read as "the same".
    expect(providersShareAccount({ state: "unknown" }, { state: "unknown" })).toBe(false);
    expect(
      providersShareAccount(
        { state: "signed-in", accountLabel: null },
        { state: "signed-in", accountLabel: null },
      ),
    ).toBe(false);
    expect(providersShareAccount(null, null)).toBe(false);
  });
});
