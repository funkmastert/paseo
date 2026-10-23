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

// The OpenAI account as the daemon reports it: one session window, nearly full, and credits.
const OPENAI_USAGE: ProviderUsage = {
  providerId: "codex",
  displayName: "Codex",
  status: "available",
  planLabel: "pro",
  windows: [{ id: "session", label: "Session", usedPct: 97, resetsAt: hoursFromNow(3) }],
  balances: [{ id: "credits", label: "Credits", remaining: 4658.87, unit: "usd", tone: "ok" }],
  // Another provider's details stay on its usage card, off the strip.
  details: [{ id: "status", label: "Status", value: "active" }],
};

// JEV as its fetcher reports it on a day the control lane ran out: the spent lane, nothing else.
// Per-feature lines moved to the JEV dashboard (docs/jev.md, "The JEV dashboard" → "Links with
// feature 11"); the strip's own details are lane alerts only.
const JEV_USAGE: ProviderUsage = {
  providerId: "jev",
  displayName: "JEV",
  status: "available",
  planLabel: "via OpenRouter",
  windows: [],
  balances: [
    {
      id: "control-today",
      label: "Control today",
      used: 1.004,
      limit: 1,
      unit: "usd",
      tone: "warning",
    },
    { id: "tools-today", label: "Agent tools today", used: 0.0412, limit: 0.5, unit: "usd" },
    { id: "ask-today", label: "Ask JEV today", used: 0.0006, limit: 0.25, unit: "usd" },
    { id: "calls-today", label: "Calls today", used: 5180, unit: "requests" },
  ],
  details: [
    {
      id: "lane:control:spent",
      label: "Control budget spent",
      value: "Spawn hint, Remediation triage, Away reply off until local midnight",
      tone: "warning",
    },
  ],
};

const agent = (provider: string, status: Agent["status"]) => ({ provider, status }) as Agent;

// One tab: its leader is on `claude`, and its workers are split across the other two accounts.
const TAB_COUNTS = countAccountUsage(
  [
    { agent: agent("claude", "running"), depth: 0 },
    { agent: agent("claude-personal", "running"), depth: 1 },
    { agent: agent("claude-personal", "running"), depth: 1 },
    { agent: agent("claude-personal", "running"), depth: 1 },
    { agent: agent("claude-backup", "running"), depth: 1 },
    { agent: agent("codex", "running"), depth: 1 },
    { agent: agent("codex", "running"), depth: 1 },
  ],
  { includeIdleLeaders: true },
);

const FIXTURE_ROWS = buildAccountBudgetRows(
  [
    account("claude", "Claude", 31, 42),
    account("claude-personal", "Claude Personal", 64, 87),
    account("claude-backup", "Claude Backup", 4, 12),
    OPENAI_USAGE,
    JEV_USAGE,
  ],
  [...POOL.map((member) => member.providerId), "codex", "jev"],
  undefined,
  { pool: POOL, usage: TAB_COUNTS },
);

const FETCHED_AT = new Date(FIXTURE_NOW_MS - 90_000);

function click(element: Element | null | undefined): void {
  act(() => {
    (element as HTMLElement)?.click();
  });
}

function Strip({
  onOpenJevDashboard,
  capMinutes,
}: {
  onOpenJevDashboard?: (serverId: string) => void;
  capMinutes?: ReadonlyMap<string, number>;
}) {
  return (
    <AccountBudgetStripView
      rows={FIXTURE_ROWS}
      serverId="fixture-host"
      fetchedAt={FETCHED_AT}
      capMinutes={capMinutes}
      onOpenJevDashboard={onOpenJevDashboard}
    />
  );
}

/**
 * The budget strip with the three-account Claude pool and the OpenAI account below it, this tab's
 * leader on one Claude account and its workers spread across the others. Rows are built from the model directly: the poll behind AccountBudgetStrip needs a live
 * host.
 */
describe.each([
  { name: "phone", width: 390, compact: true },
  { name: "desktop", width: 760, compact: false },
])("account budget strip on $name", ({ name, width, compact }) => {
  function mountStrip(
    onOpenJevDashboard?: (serverId: string) => void,
    capMinutes?: ReadonlyMap<string, number>,
  ) {
    layout.compact = compact;
    return mount(<Strip onOpenJevDashboard={onOpenJevDashboard} capMinutes={capMinutes} />, width);
  }

  it("says when an account caps, and only for an account the history projects to cap", () => {
    const container = mountStrip(undefined, new Map([["claude-personal", 150]]));
    const caps = (id: string) =>
      container.querySelector(`[data-testid="orchestration-account-caps-${id}"]`)?.textContent;
    expect(caps("claude-personal")).toContain("Caps in");
    expect(caps("claude-backup")).toBeUndefined();
    expect(caps("claude")).toBeUndefined();
  });

  it("shows the Claude pool, then the OpenAI account set apart from it", () => {
    const container = mountStrip();
    const shown = Array.from(container.querySelectorAll('[data-testid^="orchestration-account-"]'))
      .map((node) => node.getAttribute("data-testid"))
      .filter(
        (id) =>
          !id?.includes("usage-") &&
          !id?.includes("balance-") &&
          !id?.includes("detail-") &&
          !id?.includes("details-"),
      );
    expect(shown).toEqual([
      "orchestration-account-claude",
      "orchestration-account-claude-personal",
      "orchestration-account-claude-backup",
      "orchestration-account-section-rule",
      "orchestration-account-codex",
      "orchestration-account-jev",
    ]);
  });

  it("names JEV by its vendor and says it goes through OpenRouter", () => {
    const text = mountStrip().querySelector(
      '[data-testid="orchestration-account-jev"]',
    )?.textContent;
    expect(text).toContain("TypeSafe (JEV)");
    expect(text).toContain("Via OpenRouter");
  });

  it("shows JEV's spend per lane against its cap, the spent lane in the warning tone", () => {
    const container = mountStrip();
    const balance = (id: string) =>
      container.querySelector(`[data-testid="orchestration-account-balance-${id}"]`);
    expect(balance("control-today")?.textContent).toBe("Control today$1.00 / $1.00");
    expect(balance("tools-today")?.textContent).toBe("Agent tools today$0.0412 / $0.50");
    expect(balance("calls-today")?.textContent).toBe("Calls today5,180");
    const spent = container.querySelector(
      '[data-testid="orchestration-account-detail-lane:control:spent"]',
    );
    expect(spent?.textContent).toContain("Control budget spent");
    expect(spent?.textContent).toContain("off until local midnight");
  });

  it("shows the spent lane with no per-feature list and no fold toggle", () => {
    const container = mountStrip();
    const shown = (id: string) =>
      container.querySelector(`[data-testid="orchestration-account-detail-${id}"]`) !== null;
    expect(shown("lane:control:spent")).toBe(true);
    // Per-feature lines moved to the JEV dashboard; there's nothing left to fold.
    expect(shown("feature:spawnHint")).toBe(false);
    expect(
      container.querySelector('[data-testid="orchestration-account-details-toggle-jev"]'),
    ).toBeNull();
  });

  it("keeps another provider's details off the strip", () => {
    const codex = mountStrip().querySelector('[data-testid="orchestration-account-codex"]');
    expect(codex?.querySelector('[data-testid^="orchestration-account-detail-"]')).toBeNull();
  });

  it("names the OpenAI account and its plan, with no pool role", () => {
    const text = mountStrip().querySelector(
      '[data-testid="orchestration-account-codex"]',
    )?.textContent;
    expect(text).toContain("OpenAI (Codex)");
    expect(text).toContain("Pro");
    expect(text).not.toMatch(/Leader|Primary worker|Backup/);
  });

  it("shows the OpenAI account at its cap, when it resets, and its credits", () => {
    const text = mountStrip().querySelector(
      '[data-testid="orchestration-account-codex"]',
    )?.textContent;
    expect(text).toContain("97%");
    expect(text).toContain("resets 3h");
    expect(text).toContain("Credits");
    expect(text).toContain("$4,658.87 left");
  });

  it("marks the leader's account and counts the workers on each", () => {
    const container = mountStrip();
    const text = (id: string) =>
      container.querySelector(`[data-testid="orchestration-account-usage-${id}"]`)?.textContent;
    expect(text("claude")).toBe("Leader hereWorkers 0");
    expect(text("claude-personal")).toBe("Workers 3");
    expect(text("claude-backup")).toBe("Workers 1");
    expect(text("codex")).toBe("Workers 2");
  });

  it("keeps everything inside the panel", () => {
    const container = mountStrip();
    const overflowing = Array.from(container.querySelectorAll("*")).filter(
      (node) => node.scrollWidth > node.clientWidth + 1 && node.clientWidth > 0,
    );
    expect(overflowing.map((node) => node.getAttribute("data-testid") ?? node.tagName)).toEqual([]);
  });

  // Pressability and the chevron are driven by the same `isJev` gate in AccountBudgetRow
  // (account-budget-strip-view.tsx), so asserting `aria-disabled` here also covers the chevron:
  // the icon library renders nothing in this harness (no unistyles runtime), so it can't be
  // queried directly.
  it("is pressable only on the JEV row, and only when a dashboard handler is given", () => {
    const disabled = (container: HTMLElement, id: string) =>
      container
        .querySelector(`[data-testid="orchestration-account-${id}"]`)
        ?.getAttribute("aria-disabled");
    const withHandler = mountStrip(vi.fn());
    expect(disabled(withHandler, "jev")).toBeNull();
    expect(disabled(withHandler, "codex")).toBe("true");
    expect(disabled(withHandler, "claude")).toBe("true");

    const withoutHandler = mountStrip();
    expect(disabled(withoutHandler, "jev")).toBe("true");
  });

  it("opens the JEV dashboard for this host when its row is pressed", () => {
    const onOpenJevDashboard = vi.fn();
    const container = mountStrip(onOpenJevDashboard);
    click(container.querySelector('[data-testid="orchestration-account-jev"]'));
    expect(onOpenJevDashboard).toHaveBeenCalledExactlyOnceWith("fixture-host");

    click(container.querySelector('[data-testid="orchestration-account-codex"]'));
    expect(onOpenJevDashboard).toHaveBeenCalledOnce();
  });

  it("captures the strip", async () => {
    await page.viewport(width + 24, compact ? 1400 : 900);
    const container = mountStrip();
    await page.screenshot({
      element: container,
      path: `../../../../docs/assets/orchestration-account-strip-${name}.png`,
    });
  });
});
