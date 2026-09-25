import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@/stores/session-store";
import type { ProviderUsage } from "@/provider-usage/types";
import { AccountBudgetStripView } from "./account-budget-strip-view";
import { buildAccountBudgetRows, countAccountUsage } from "./account-budget-strip-model";
import { FIXTURE_NOW_MS } from "./fixture-fleet";
// Side-effecting: creating the instance is what registers it with react-i18next, so the strip
// renders its real copy rather than raw keys.
// eslint-disable-next-line import/no-unassigned-import
import "@/i18n/i18next";

// The unistyles stub has no runtime, so the real hook never reports a compact form factor.
const layout = vi.hoisted(() => ({ compact: false }));
vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => layout.compact,
}));

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(FIXTURE_NOW_MS);
});

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  layout.compact = false;
  vi.useRealTimers();
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function mount(node: ReactNode, width: number): HTMLDivElement {
  const container = document.createElement("div");
  container.style.width = `${width}px`;
  container.style.padding = "12px";
  container.style.boxSizing = "border-box";
  document.body.style.margin = "0";
  document.body.style.width = `${width}px`;
  document.body.style.background = "#fff";
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

const hoursFromNow = (hours: number) => new Date(FIXTURE_NOW_MS + hours * 3_600_000).toISOString();

function account(
  providerId: string,
  displayName: string,
  session: number,
  weekly: number,
): ProviderUsage {
  return {
    providerId,
    displayName,
    status: "available",
    planLabel: null,
    windows: [
      { id: "five_hour", label: "Session", usedPct: session, resetsAt: hoursFromNow(2) },
      { id: "weekly", label: "Weekly", usedPct: weekly, resetsAt: hoursFromNow(52) },
    ],
  };
}

const POOL = [
  { providerId: "claude", role: "leader" },
  { providerId: "claude-personal", role: "primary" },
  { providerId: "claude-backup", role: "backup" },
] as const;

const agent = (provider: string, status: Agent["status"]) => ({ provider, status }) as Agent;

// One tab: its leader is on `claude`, and its workers are split across the other two accounts.
const TAB_COUNTS = countAccountUsage(
  [
    { agent: agent("claude", "running"), depth: 0 },
    { agent: agent("claude-personal", "running"), depth: 1 },
    { agent: agent("claude-personal", "running"), depth: 1 },
    { agent: agent("claude-personal", "running"), depth: 1 },
    { agent: agent("claude-backup", "running"), depth: 1 },
  ],
  { includeIdleLeaders: true },
);

const FIXTURE_ROWS = buildAccountBudgetRows(
  [
    account("claude", "Claude", 31, 42),
    account("claude-personal", "Claude Personal", 64, 87),
    account("claude-backup", "Claude Backup", 4, 12),
  ],
  POOL.map((member) => member.providerId),
  undefined,
  { pool: POOL, usage: TAB_COUNTS },
);

const FETCHED_AT = new Date(FIXTURE_NOW_MS - 90_000);

function Strip() {
  return (
    <AccountBudgetStripView rows={FIXTURE_ROWS} serverId="fixture-host" fetchedAt={FETCHED_AT} />
  );
}

/**
 * The budget strip with three accounts, this tab's leader on one and its workers on the other
 * two. Rows are built from the model directly: the poll behind AccountBudgetStrip needs a live
 * host.
 */
describe.each([
  { name: "phone", width: 390, compact: true },
  { name: "desktop", width: 760, compact: false },
])("account budget strip on $name", ({ name, width, compact }) => {
  function mountStrip() {
    layout.compact = compact;
    return mount(<Strip />, width);
  }

  it("shows all three accounts", () => {
    const container = mountStrip();
    const shown = Array.from(container.querySelectorAll('[data-testid^="orchestration-account-c"]'))
      .map((node) => node.getAttribute("data-testid"))
      .filter((id) => !id?.includes("usage"));
    expect(shown).toEqual([
      "orchestration-account-claude",
      "orchestration-account-claude-personal",
      "orchestration-account-claude-backup",
    ]);
  });

  it("marks the leader's account and counts the workers on each", () => {
    const container = mountStrip();
    const text = (id: string) =>
      container.querySelector(`[data-testid="orchestration-account-usage-${id}"]`)?.textContent;
    expect(text("claude")).toBe("Leader hereWorkers 0");
    expect(text("claude-personal")).toBe("Workers 3");
    expect(text("claude-backup")).toBe("Workers 1");
  });

  it("keeps everything inside the panel", () => {
    const container = mountStrip();
    const overflowing = Array.from(container.querySelectorAll("*")).filter(
      (node) => node.scrollWidth > node.clientWidth + 1 && node.clientWidth > 0,
    );
    expect(overflowing.map((node) => node.getAttribute("data-testid") ?? node.tagName)).toEqual([]);
  });

  it("captures the strip", async () => {
    await page.viewport(width + 24, 600);
    const container = mountStrip();
    await page.screenshot({
      element: container,
      path: `../../../../docs/assets/orchestration-account-strip-${name}.png`,
    });
  });
});
