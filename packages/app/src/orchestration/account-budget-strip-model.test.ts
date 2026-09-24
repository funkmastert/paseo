import { describe, expect, it, vi } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { ProviderUsage } from "@/provider-usage/types";
import type { Agent } from "@/stores/session-store";
import {
  buildAccountBudgetRows,
  countAccountUsage,
  resolveAccountPool,
  resolveBudgetProviderIds,
  resolveAccountIcon,
  resolveAccountLabel,
  selectBudgetWindows,
  selectWorstBudgetWindow,
} from "./account-budget-strip-model";

const getProviderIconMock = vi.hoisted(() => vi.fn(() => () => null));
vi.mock("@/components/provider-icons", () => ({
  getProviderIcon: getProviderIconMock,
}));

const POOL = [
  { providerId: "claude", role: "leader" },
  { providerId: "claude-personal", role: "primary" },
  { providerId: "claude-backup", role: "backup" },
] as const;

function usage(overrides: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    providerId: "claude",
    displayName: "Claude",
    status: "available",
    planLabel: null,
    windows: [
      { id: "five_hour", label: "Session", usedPct: 12 },
      { id: "weekly", label: "Weekly", usedPct: 34 },
    ],
    ...overrides,
  };
}

describe("resolveAccountLabel", () => {
  it("prefers the providers-snapshot label for a matching provider id", () => {
    const entries: ProviderSnapshotEntry[] = [
      {
        provider: "claude-personal",
        status: "ready",
        enabled: true,
        label: "Personal Claude",
      },
    ];
    const label = resolveAccountLabel(entries, usage({ providerId: "claude-personal" }));
    expect(label).toBe("Personal Claude");
  });

  it("falls back to the usage displayName when no snapshot entry matches", () => {
    const label = resolveAccountLabel([], usage({ providerId: "claude", displayName: "Claude" }));
    expect(label).toBe("Claude");
  });

  it("falls back to the usage displayName when entries are undefined", () => {
    const label = resolveAccountLabel(undefined, usage({ displayName: "Claude" }));
    expect(label).toBe("Claude");
  });
});

describe("selectBudgetWindows", () => {
  it("keeps only the five_hour and weekly windows, in that order", () => {
    const windows = selectBudgetWindows(
      usage({
        windows: [
          { id: "weekly", label: "Weekly", usedPct: 34 },
          { id: "five_hour", label: "Session", usedPct: 12 },
          { id: "balance", label: "Balance", usedPct: 5 },
        ],
      }),
    );
    expect(windows.map((w) => w.id)).toEqual(["five_hour", "weekly"]);
  });

  it("omits a window the provider doesn't report", () => {
    const windows = selectBudgetWindows(
      usage({ windows: [{ id: "weekly", label: "Weekly", usedPct: 34 }] }),
    );
    expect(windows.map((w) => w.id)).toEqual(["weekly"]);
  });
});

describe("resolveAccountIcon", () => {
  it("passes serverId through to getProviderIcon so custom entries resolve their snapshot icon", () => {
    getProviderIconMock.mockClear();
    resolveAccountIcon("claude-personal", "server-1");
    expect(getProviderIconMock).toHaveBeenCalledWith("claude-personal", "server-1");
  });
});

describe("buildAccountBudgetRows", () => {
  it("builds one row per matched provider id, case-insensitively", () => {
    const providers = [
      usage({ providerId: "claude", displayName: "Claude" }),
      usage({ providerId: "claude-personal", displayName: "Claude (personal)" }),
      usage({ providerId: "codex", displayName: "Codex" }),
    ];

    const rows = buildAccountBudgetRows(providers, ["claude", "claude-personal"], []);

    expect(rows.map((row) => row.providerId)).toEqual(["claude", "claude-personal"]);
    expect(rows.every((row) => row.kind === "available")).toBe(true);
  });

  it("renders a muted unavailable row for an account whose usage status isn't available, without throwing", () => {
    const providers = [
      usage({
        providerId: "claude",
        status: "unavailable",
        windows: [],
        error: "No session found",
      }),
    ];

    const rows = buildAccountBudgetRows(providers, ["claude"], []);

    expect(rows).toEqual([
      { kind: "unavailable", providerId: "claude", label: "Claude", role: null, usage: null },
    ]);
  });

  it("drops a requested provider with no usage entry when it is not in the pool", () => {
    const rows = buildAccountBudgetRows(
      [usage({ providerId: "claude" })],
      ["claude", "opencode"],
      [],
    );
    expect(rows.map((row) => row.providerId)).toEqual(["claude"]);
  });

  it("keeps a pool member the usage endpoint has no entry for, as an unavailable row", () => {
    const rows = buildAccountBudgetRows(
      [usage({ providerId: "claude" })],
      ["claude", "claude-backup"],
      [{ provider: "claude-backup", status: "ready", enabled: true, label: "Claude (Backup)" }],
      { pool: POOL, usage: new Map() },
    );
    expect(rows[1]).toMatchObject({
      kind: "unavailable",
      providerId: "claude-backup",
      label: "Claude (Backup)",
      role: "backup",
    });
  });

  it("carries each account's pool role and live counts, zero when nothing is running on it", () => {
    const rows = buildAccountBudgetRows(
      POOL.map((member) => usage({ providerId: member.providerId })),
      POOL.map((member) => member.providerId),
      undefined,
      { pool: POOL, usage: new Map([["claude", { leaders: 2, workers: 0 }]]) },
    );
    expect(rows.map((row) => [row.providerId, row.role, row.usage])).toEqual([
      ["claude", "leader", { leaders: 2, workers: 0 }],
      ["claude-personal", "primary", { leaders: 0, workers: 0 }],
      ["claude-backup", "backup", { leaders: 0, workers: 0 }],
    ]);
  });

  it("uses the snapshot label for the join between usage and providers snapshot", () => {
    const providers = [usage({ providerId: "claude", displayName: "Claude" })];
    const entries: ProviderSnapshotEntry[] = [
      { provider: "claude", status: "ready", enabled: true, label: "Work Claude" },
    ];

    const rows = buildAccountBudgetRows(providers, ["claude"], entries);

    expect(rows[0]).toMatchObject({ label: "Work Claude" });
  });
});

describe("selectWorstBudgetWindow", () => {
  const rowsFor = (...usages: ProviderUsage[]) =>
    buildAccountBudgetRows(
      usages,
      usages.map((u) => u.providerId),
      undefined,
    );

  it("picks the fullest window across every account, not the fullest account's first", () => {
    const worst = selectWorstBudgetWindow(
      rowsFor(
        usage({ providerId: "a", windows: [{ id: "five_hour", label: "Session", usedPct: 40 }] }),
        usage({
          providerId: "b",
          windows: [
            { id: "five_hour", label: "Session", usedPct: 4 },
            { id: "weekly", label: "Weekly", usedPct: 85 },
          ],
        }),
      ),
    );
    expect(worst).toMatchObject({
      usedPct: 85,
      window: { id: "weekly" },
      row: { providerId: "b" },
    });
  });

  it("reads remaining as used when a window has no used figure", () => {
    const worst = selectWorstBudgetWindow(
      rowsFor(usage({ windows: [{ id: "weekly", label: "Weekly", remainingPct: 10 }] })),
    );
    expect(worst?.usedPct).toBe(90);
  });

  it("skips unavailable accounts and windows with no reading", () => {
    expect(
      selectWorstBudgetWindow(
        rowsFor(
          usage({ providerId: "a", status: "unavailable", windows: [] }),
          usage({ providerId: "b", windows: [{ id: "weekly", label: "Weekly" }] }),
        ),
      ),
    ).toBeNull();
  });
});

describe("resolveAccountPool", () => {
  const entry = (accountPool: unknown) => ({ label: "x", params: { accountPool } });

  it("puts the leader first, then workers by priority: the first is the primary, the rest backups", () => {
    const pool = resolveAccountPool({
      "claude-backup": entry({ role: "worker", priority: 2 }),
      claude: entry({ role: "leader", priority: 1 }),
      "claude-personal": entry({ role: "worker", priority: 1 }),
      codex: { label: "Codex" },
    });
    expect(pool).toEqual([
      { providerId: "claude", role: "leader" },
      { providerId: "claude-personal", role: "primary" },
      { providerId: "claude-backup", role: "backup" },
    ]);
  });

  it("reads the role from the pool config, not the account's id or label", () => {
    const pool = resolveAccountPool({
      "claude-backup": entry({ role: "worker", priority: 1 }),
      "claude-personal": entry({ role: "worker", priority: 2 }),
    });
    expect(pool).toEqual([
      { providerId: "claude-backup", role: "primary" },
      { providerId: "claude-personal", role: "backup" },
    ]);
  });

  it("yields no pool for a host without one, and skips malformed entries", () => {
    expect(resolveAccountPool(undefined)).toEqual([]);
    expect(resolveAccountPool({ claude: { params: {} } })).toEqual([]);
    expect(resolveAccountPool({ claude: entry({ role: "owner", priority: 1 }) })).toEqual([]);
    expect(resolveAccountPool({ claude: entry("leader") })).toEqual([]);
  });
});

describe("resolveBudgetProviderIds", () => {
  it("lists every pool account whether or not an agent is on it, then the tree's other providers", () => {
    expect(resolveBudgetProviderIds(POOL, ["codex", "claude"])).toEqual([
      "claude",
      "claude-personal",
      "claude-backup",
      "codex",
    ]);
  });

  it("falls back to the tree's providers when the host has no pool", () => {
    expect(resolveBudgetProviderIds([], ["claude", "codex"])).toEqual(["claude", "codex"]);
  });
});

describe("countAccountUsage", () => {
  const row = (provider: string, status: Agent["status"], depth: number) =>
    ({ agent: { provider, status } as Agent, depth }) as const;

  it("counts running roots as leaders and running descendants as workers, per account", () => {
    const counts = countAccountUsage([
      row("claude", "running", 0),
      row("claude-personal", "running", 1),
      row("claude-personal", "initializing", 2),
      row("claude-backup", "running", 1),
    ]);
    expect(counts.get("claude")).toEqual({ leaders: 1, workers: 0 });
    expect(counts.get("claude-personal")).toEqual({ leaders: 0, workers: 2 });
    expect(counts.get("claude-backup")).toEqual({ leaders: 0, workers: 1 });
  });

  it("counts an idle leader while a worker under it is running, not once the work stops", () => {
    const counts = countAccountUsage([
      row("claude", "idle", 0),
      row("claude-personal", "running", 1),
      row("claude", "idle", 0),
      row("claude-personal", "idle", 1),
    ]);
    expect(counts.get("claude")).toEqual({ leaders: 1, workers: 0 });
    expect(counts.get("claude-personal")).toEqual({ leaders: 0, workers: 1 });
  });

  it("does not count agents that are not running", () => {
    const counts = countAccountUsage([
      row("claude", "idle", 0),
      row("claude-personal", "closed", 1),
      row("claude-backup", "error", 1),
    ]);
    expect(counts.size).toBe(0);
  });
});
