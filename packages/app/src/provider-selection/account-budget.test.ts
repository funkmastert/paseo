import { describe, expect, it } from "vitest";
import type { ProviderUsage, ProviderUsageWindow } from "@/provider-usage/types";
import type { AccountPoolMember } from "@/orchestration/account-budget-strip-model";
import {
  avoidOutOfBudgetAccount,
  buildAccountBudgetNotes,
  findAccountOutOfBudget,
  formatOutOfBudget,
  type AccountBudget,
} from "./account-budget";

const POOL: AccountPoolMember[] = [
  { providerId: "claude", role: "leader" },
  { providerId: "claude-personal", role: "primary" },
  { providerId: "claude-backup", role: "backup" },
];

// Local time, so the weekday and clock in the label don't depend on the test machine's zone.
const SATURDAY_6AM = new Date(2026, 8, 26, 6, 0).toISOString();

function usage(providerId: string, windows: ProviderUsageWindow[]): ProviderUsage {
  return {
    providerId,
    displayName: providerId,
    status: "available",
    planLabel: null,
    windows,
  } as ProviderUsage;
}

function window(id: string, usedPct: number, resetsAt?: string): ProviderUsageWindow {
  return { id, label: id, usedPct, ...(resetsAt ? { resetsAt } : {}) } as ProviderUsageWindow;
}

function budget(usages: ProviderUsage[]): AccountBudget {
  return { pool: POOL, usage: usages };
}

const allSelectable = () => true;
const noModel = () => null;

describe("findAccountOutOfBudget", () => {
  it("reports a pooled account whose weekly window is at 100%", () => {
    const out = findAccountOutOfBudget(
      budget([usage("claude-backup", [window("weekly", 100, SATURDAY_6AM)])]),
      "claude-backup",
    );
    expect(out).toEqual({
      providerId: "claude-backup",
      windowId: "weekly",
      resetsAt: SATURDAY_6AM,
    });
  });

  it("does not count a drained account: only a window at its cap is out", () => {
    expect(
      findAccountOutOfBudget(
        budget([usage("claude-backup", [window("five_hour", 97)])]),
        "claude-backup",
      ),
    ).toBeNull();
  });

  it("counts the model's own weekly window only for that model", () => {
    const b = budget([usage("claude-backup", [window("weekly_model_opus", 100)])]);
    expect(findAccountOutOfBudget(b, "claude-backup", "claude-opus-5-5")?.windowId).toBe(
      "weekly_model_opus",
    );
    expect(findAccountOutOfBudget(b, "claude-backup", "claude-sonnet-5")).toBeNull();
    expect(findAccountOutOfBudget(b, "claude-backup")).toBeNull();
  });

  it("ignores providers outside the account pool", () => {
    expect(
      findAccountOutOfBudget(budget([usage("codex", [window("weekly", 100)])]), "codex"),
    ).toBeNull();
  });
});

describe("avoidOutOfBudgetAccount", () => {
  it("falls back to the leader account when the remembered account is out", () => {
    const b = budget([
      usage("claude-backup", [window("weekly", 100)]),
      usage("claude", [window("weekly", 42)]),
      usage("claude-personal", [window("weekly", 19)]),
    ]);
    expect(
      avoidOutOfBudgetAccount({
        provider: "claude-backup",
        budget: b,
        isSelectable: allSelectable,
        modelFor: noModel,
      }),
    ).toBe("claude");
  });

  it("keeps the remembered account while it has budget", () => {
    const b = budget([usage("claude-backup", [window("weekly", 42)])]);
    expect(
      avoidOutOfBudgetAccount({
        provider: "claude-backup",
        budget: b,
        isSelectable: allSelectable,
        modelFor: noModel,
      }),
    ).toBe("claude-backup");
  });

  it("falls to the worker with the most room when the leader is out too", () => {
    const b = budget([
      usage("claude", [window("five_hour", 100)]),
      usage("claude-backup", [window("weekly", 100)]),
      usage("claude-personal", [window("weekly", 19)]),
    ]);
    expect(
      avoidOutOfBudgetAccount({
        provider: "claude-backup",
        budget: b,
        isSelectable: allSelectable,
        modelFor: noModel,
      }),
    ).toBe("claude-personal");
  });

  it("skips an account the form can't select", () => {
    const b = budget([usage("claude-backup", [window("weekly", 100)])]);
    expect(
      avoidOutOfBudgetAccount({
        provider: "claude-backup",
        budget: b,
        isSelectable: (id) => id !== "claude",
        modelFor: noModel,
      }),
    ).toBe("claude-personal");
  });

  it("keeps the remembered account when nothing else can serve", () => {
    const b = budget(POOL.map((member) => usage(member.providerId, [window("weekly", 100)])));
    expect(
      avoidOutOfBudgetAccount({
        provider: "claude-backup",
        budget: b,
        isSelectable: allSelectable,
        modelFor: noModel,
      }),
    ).toBe("claude-backup");
  });

  it("checks each account against the model remembered for it", () => {
    const b = budget([usage("claude-backup", [window("weekly_model_opus", 100)])]);
    expect(
      avoidOutOfBudgetAccount({
        provider: "claude-backup",
        budget: b,
        isSelectable: allSelectable,
        modelFor: (id) => (id === "claude-backup" ? "claude-opus-5-5" : null),
      }),
    ).toBe("claude");
  });
});

describe("formatOutOfBudget", () => {
  it("names the weekday and time the window comes back", () => {
    expect(
      formatOutOfBudget({
        providerId: "claude-backup",
        windowId: "weekly",
        resetsAt: SATURDAY_6AM,
      }),
    ).toBe("out until Sat 06:00");
  });

  it("says only that it is out when no reset is known", () => {
    expect(
      formatOutOfBudget({ providerId: "claude-backup", windowId: "weekly", resetsAt: null }),
    ).toBe("out of budget");
  });
});

describe("buildAccountBudgetNotes", () => {
  it("notes only the pooled accounts that are out", () => {
    const notes = buildAccountBudgetNotes(
      budget([
        usage("claude-backup", [window("weekly", 100, SATURDAY_6AM)]),
        usage("claude", [window("weekly", 42)]),
      ]),
    );
    expect([...notes]).toEqual([["claude-backup", "out until Sat 06:00"]]);
  });

  it("is empty without a budget", () => {
    expect(buildAccountBudgetNotes(null).size).toBe(0);
  });
});
