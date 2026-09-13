import { describe, expect, it, vi } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { ProviderUsage } from "@/provider-usage/types";
import {
  buildAccountBudgetRows,
  filterProviderUsageByIds,
  resolveAccountIcon,
  resolveAccountLabel,
  selectBudgetWindows,
} from "./account-budget-strip-model";

const getProviderIconMock = vi.hoisted(() => vi.fn(() => () => null));
vi.mock("@/components/provider-icons", () => ({
  getProviderIcon: getProviderIconMock,
}));

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

describe("filterProviderUsageByIds", () => {
  it("matches case-insensitively and keeps only the requested provider ids", () => {
    const providers = [
      usage({ providerId: "Claude" }),
      usage({ providerId: "claude-personal", displayName: "Claude (personal)" }),
      usage({ providerId: "Codex", displayName: "Codex" }),
    ];

    const rows = filterProviderUsageByIds(providers, ["CLAUDE", "Claude-Personal"]);

    expect(rows.map((row) => row.providerId)).toEqual(["Claude", "claude-personal"]);
  });

  it("drops requested ids with no matching usage entry", () => {
    const providers = [usage({ providerId: "claude" })];
    const rows = filterProviderUsageByIds(providers, ["claude", "opencode"]);
    expect(rows.map((row) => row.providerId)).toEqual(["claude"]);
  });
});

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

    expect(rows).toEqual([{ kind: "unavailable", providerId: "claude", label: "Claude" }]);
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
