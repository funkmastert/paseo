import { describe, expect, it } from "vitest";
import { pickFailoverTarget, resolveAccountPoolEntries } from "./account-pool-providers.js";

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
    expect(entries).toEqual([
      { providerId: "claude-w1", role: "worker", priority: 1, enabled: false },
    ]);
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

  it("never falls back to the leader account, even when it is healthy", () => {
    expect(
      pickFailoverTarget(entries, {
        deadProviderIds: new Set(["claude-w1a", "claude-w1b", "claude-w2"]),
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
