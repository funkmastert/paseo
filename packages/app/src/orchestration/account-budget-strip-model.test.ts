import { describe, expect, it, vi } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { ProviderUsage } from "@/provider-usage/types";
import type { Agent } from "@/stores/session-store";
import {
  buildAccountBudgetRows,
  countAccountUsage,
  isClaudeFamilyProviderId,
  resolveAccountPool,
  resolveBudgetProviderIds,
  resolveHostClaudeAccountIds,
  resolveOtherAccountIds,
  resolveAccountIcon,
  resolveAccountLabel,
  selectBudgetWindows,
  selectAccountWorstWindow,
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
      {
        kind: "unavailable",
        providerId: "claude",
        section: "claude",
        label: "Claude",
        plan: null,
        role: null,
        usage: null,
      },
    ]);
  });

  it("keeps every requested account, as an unavailable row when the usage endpoint has no entry for it", () => {
    const rows = buildAccountBudgetRows(
      [usage({ providerId: "claude" })],
      ["claude", "claude-personal"],
      [],
    );
    expect(rows.map((row) => [row.providerId, row.kind, row.role])).toEqual([
      ["claude", "available", null],
      ["claude-personal", "unavailable", null],
    ]);
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

describe("selectAccountWorstWindow", () => {
  const rowFor = (u: ProviderUsage) => buildAccountBudgetRows([u], [u.providerId], undefined)[0];

  it("picks the account's fullest window", () => {
    const worst = selectAccountWorstWindow(
      rowFor(
        usage({
          windows: [
            { id: "five_hour", label: "Session", usedPct: 4 },
            { id: "weekly", label: "Weekly", usedPct: 85 },
          ],
        }),
      ),
    );
    expect(worst).toMatchObject({ usedPct: 85, window: { id: "weekly" } });
  });

  it("reads remaining as used when a window has no used figure", () => {
    const worst = selectAccountWorstWindow(
      rowFor(usage({ windows: [{ id: "weekly", label: "Weekly", remainingPct: 10 }] })),
    );
    expect(worst?.usedPct).toBe(90);
  });

  it("is null for an unavailable account or a window with no reading", () => {
    expect(
      selectAccountWorstWindow(rowFor(usage({ status: "unavailable", windows: [] }))),
    ).toBeNull();
    expect(
      selectAccountWorstWindow(rowFor(usage({ windows: [{ id: "weekly", label: "Weekly" }] }))),
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

describe("isClaudeFamilyProviderId", () => {
  it("matches claude and any claude-* account, case-insensitively, and nothing else", () => {
    expect(isClaudeFamilyProviderId("claude")).toBe(true);
    expect(isClaudeFamilyProviderId("Claude-Personal")).toBe(true);
    expect(isClaudeFamilyProviderId("codex")).toBe(false);
    expect(isClaudeFamilyProviderId("claudette")).toBe(false);
  });
});

describe("resolveHostClaudeAccountIds", () => {
  const entry = (provider: string, enabled = true): ProviderSnapshotEntry => ({
    provider,
    status: "ready",
    enabled,
  });

  it("lists the Claude-family accounts the usage payload reports, claude first", () => {
    expect(
      resolveHostClaudeAccountIds(
        [
          usage({ providerId: "codex" }),
          usage({ providerId: "claude-personal" }),
          usage({ providerId: "claude" }),
          usage({ providerId: "claude-backup" }),
        ],
        undefined,
      ),
    ).toEqual(["claude", "claude-backup", "claude-personal"]);
  });

  it("adds accounts only the providers snapshot knows, skipping disabled ones and duplicates", () => {
    expect(
      resolveHostClaudeAccountIds(
        [usage({ providerId: "claude" })],
        [entry("claude"), entry("Claude-Personal"), entry("claude-old", false), entry("codex")],
      ),
    ).toEqual(["claude", "Claude-Personal"]);
  });

  it("falls back to every usage provider on a host with no Claude account", () => {
    expect(
      resolveHostClaudeAccountIds(
        [usage({ providerId: "codex" }), usage({ providerId: "opencode" })],
        undefined,
      ),
    ).toEqual(["codex", "opencode"]);
  });

  it("is empty before the host has reported anything", () => {
    expect(resolveHostClaudeAccountIds([], undefined)).toEqual([]);
  });
});

describe("resolveBudgetProviderIds", () => {
  it("lists every pool account, whether or not an agent is on it", () => {
    expect(resolveBudgetProviderIds(POOL, ["claude", "claude-other"])).toEqual([
      "claude",
      "claude-personal",
      "claude-backup",
    ]);
  });

  it("lists the host's Claude accounts when the config is unavailable, never the tree's", () => {
    expect(resolveBudgetProviderIds([], ["claude", "claude-personal", "claude-backup"])).toEqual([
      "claude",
      "claude-personal",
      "claude-backup",
    ]);
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

describe("countAccountUsage for one tab", () => {
  const row = (provider: string, status: Agent["status"], depth: number) =>
    ({ agent: { provider, status } as Agent, depth }) as const;

  it("counts an idle leader with nothing running below it when the tab is one leader's tree", () => {
    const counts = countAccountUsage([row("claude", "idle", 0), row("claude-backup", "idle", 1)], {
      includeIdleLeaders: true,
    });
    expect(counts.get("claude")).toEqual({ leaders: 1, workers: 0 });
    expect(counts.has("claude-backup")).toBe(false);
  });

  it("splits one leader's workers across accounts", () => {
    const counts = countAccountUsage(
      [
        row("claude", "running", 0),
        row("claude-personal", "running", 1),
        row("claude-personal", "running", 1),
        row("claude-backup", "running", 2),
      ],
      { includeIdleLeaders: true },
    );
    expect(counts.get("claude")).toEqual({ leaders: 1, workers: 0 });
    expect(counts.get("claude-personal")).toEqual({ leaders: 0, workers: 2 });
    expect(counts.get("claude-backup")).toEqual({ leaders: 0, workers: 1 });
  });
});

function codexUsage(overrides: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    providerId: "codex",
    displayName: "Codex",
    status: "available",
    planLabel: "pro",
    windows: [
      { id: "session", label: "Session", usedPct: 97, resetsAt: "2026-09-26T09:21:00.000Z" },
    ],
    balances: [{ id: "credits", label: "Credits", remaining: 4658.87, unit: "usd", tone: "ok" }],
    ...overrides,
  };
}

describe("resolveOtherAccountIds", () => {
  it("lists every non-Claude provider that reports a window or a balance", () => {
    const ids = resolveOtherAccountIds(
      [
        usage({ providerId: "claude" }),
        codexUsage(),
        usage({ providerId: "future", windows: [], balances: [] }),
        usage({ providerId: "balance-only", windows: [], balances: codexUsage().balances }),
      ],
      [],
    );
    expect(ids).toEqual(["codex", "balance-only"]);
  });

  it("keeps a provider whose usage fetch failed, so the failure shows instead of the account vanishing", () => {
    const ids = resolveOtherAccountIds(
      [codexUsage({ status: "error", windows: [], balances: [], error: "boom" })],
      [],
    );
    expect(ids).toEqual(["codex"]);
  });

  it("skips a provider that reports no usage support, and one the host has disabled", () => {
    const ids = resolveOtherAccountIds(
      [
        codexUsage({ providerId: "copilot", status: "unavailable", windows: [], balances: [] }),
        codexUsage(),
      ],
      [{ provider: "codex", enabled: false }],
    );
    expect(ids).toEqual([]);
  });
});

describe("buildAccountBudgetRows for a non-Claude account", () => {
  const build = (u: ProviderUsage, entries?: ProviderSnapshotEntry[]) =>
    buildAccountBudgetRows([u], [u.providerId], entries, {
      pool: POOL,
      usage: new Map([["codex", { leaders: 0, workers: 2 }]]),
    })[0];

  it("is included as its own section, with no pool role", () => {
    expect(build(codexUsage())).toMatchObject({
      kind: "available",
      providerId: "codex",
      section: "other",
      role: null,
    });
  });

  it("is labelled as OpenAI and carries the plan capitalised", () => {
    expect(build(codexUsage())).toMatchObject({ label: "OpenAI (Codex)", plan: "Pro" });
  });

  it("does not repeat the vendor when the snapshot label already names it", () => {
    const entries: ProviderSnapshotEntry[] = [
      { provider: "codex", status: "ready", enabled: true, label: "OpenAI Codex" },
    ];
    expect(build(codexUsage(), entries)).toMatchObject({ label: "OpenAI Codex" });
  });

  it("uses the display name alone for a provider with no known vendor", () => {
    expect(build(codexUsage({ providerId: "future", displayName: "Future" }))).toMatchObject({
      label: "Future",
      section: "other",
    });
  });

  it("keeps every window the provider reports, not only the Claude session and weekly ones", () => {
    const row = build(codexUsage());
    expect(row.kind === "available" && row.windows.map((window) => window.id)).toEqual(["session"]);
    expect(selectAccountWorstWindow(row)).toMatchObject({ usedPct: 97 });
  });

  it("formats balances compactly, with the tone the provider reports", () => {
    const row = build(codexUsage());
    expect(row.kind === "available" && row.balances).toEqual([
      { id: "credits", label: "Credits", amount: "$4,658.87", remaining: true, tone: "ok" },
    ]);
  });

  it("shows used against the limit when a balance has a limit, and a bare figure otherwise", () => {
    const row = build(
      codexUsage({
        balances: [
          { id: "a", label: "Spend", used: 12, limit: 50, unit: "usd", tone: "warning" },
          { id: "b", label: "Requests", used: 1200, unit: "requests" },
          { id: "c", label: "Empty", unit: "tokens" },
        ],
      }),
    );
    expect(row.kind === "available" && row.balances).toEqual([
      { id: "a", label: "Spend", amount: "$12.00 / $50.00", remaining: false, tone: "warning" },
      { id: "b", label: "Requests", amount: "1,200", remaining: false, tone: "default" },
      { id: "c", label: "Empty", amount: "—", remaining: false, tone: "default" },
    ]);
  });

  it("carries no balances for a Claude account that reports none", () => {
    const row = buildAccountBudgetRows([usage()], ["claude"], undefined)[0];
    expect(row).toMatchObject({ section: "claude", kind: "available", balances: [] });
  });

  it("carries the leader and worker counts of the agents running on it", () => {
    expect(build(codexUsage()).usage).toEqual({ leaders: 0, workers: 2 });
  });

  describe("the OpenAI API (image gen) account", () => {
    const openAiApi = (overrides: Partial<ProviderUsage> = {}): ProviderUsage => ({
      providerId: "openai-api",
      displayName: "OpenAI API (image gen)",
      status: "available",
      planLabel: null,
      windows: [
        {
          id: "month",
          label: "Month",
          usedPct: 25,
          remainingPct: 75,
          resetsAt: "2026-10-01T00:00:00.000Z",
          tone: "ok",
        },
      ],
      balances: [{ id: "spend", label: "Spent this month", used: 12.5, limit: 50, unit: "usd" }],
      ...overrides,
    });

    it("is listed as an account and keeps its own label, with the vendor named once", () => {
      expect(resolveOtherAccountIds([openAiApi()], undefined)).toEqual(["openai-api"]);
      expect(build(openAiApi())).toMatchObject({
        kind: "available",
        section: "other",
        label: "OpenAI API (image gen)",
        plan: null,
      });
    });

    it("shows the spend line, and the month window as the meter when a budget is set", () => {
      const row = build(openAiApi());
      expect(row.kind === "available" && row.balances).toEqual([
        {
          id: "spend",
          label: "Spent this month",
          amount: "$12.50 / $50.00",
          remaining: false,
          tone: "default",
        },
      ]);
      expect(selectAccountWorstWindow(row)).toMatchObject({
        usedPct: 25,
        window: { id: "month" },
      });
    });

    it("shows the spend alone, with no meter, when no budget is set", () => {
      const row = build(
        openAiApi({
          windows: [],
          balances: [{ id: "spend", label: "Spent this month", used: 12.5, unit: "usd" }],
        }),
      );
      expect(row.kind === "available" && row.balances[0]?.amount).toBe("$12.50");
      expect(selectAccountWorstWindow(row)).toBeNull();
    });

    it("carries the daemon's hint on the unavailable row", () => {
      const row = build(
        openAiApi({
          status: "error",
          windows: [],
          balances: [],
          error: "Add OPENAI_API_KEY to ~/.config/openai/env",
        }),
      );
      expect(row).toMatchObject({
        kind: "unavailable",
        section: "other",
        error: "Add OPENAI_API_KEY to ~/.config/openai/env",
      });
    });

    it("uses the OpenAI icon rather than the generic one", () => {
      resolveAccountIcon("openai-api", "server-1");
      expect(getProviderIconMock).toHaveBeenLastCalledWith("codex", "server-1");
    });
  });

  it("shows unavailable when its usage fetch failed", () => {
    const row = build(codexUsage({ status: "error", windows: [], balances: [] }));
    expect(row).toMatchObject({ kind: "unavailable", providerId: "codex", section: "other" });
    expect(row.kind === "unavailable" && "balances" in row).toBe(false);
  });
});
