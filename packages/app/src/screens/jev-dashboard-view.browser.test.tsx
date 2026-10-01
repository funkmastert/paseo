import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JEV_SAVINGS_EVENTS_FIXTURE,
  JEV_SAVINGS_SUMMARY_FIXTURES,
} from "@/jev/jev-savings-fixtures";
// Side-effecting: creating the instance is what registers it with react-i18next.
// eslint-disable-next-line import/no-unassigned-import
import "@/i18n/i18next";
import {
  JevDashboardReadyContent,
  NotConfiguredBanner,
  resolveJevDashboardAvailability,
  type JevDashboardAvailability,
} from "./jev-dashboard-view";

const PHONE_WIDTH = 390;
const DESKTOP_WIDTH = 900;

// The unistyles stub has no runtime, so the real hook never reports a compact form factor
// (account-budget-strip.browser.test.tsx uses the same mock).
const layout = vi.hoisted(() => ({ compact: false }));
vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => layout.compact,
}));

beforeEach(() => {
  vi.stubGlobal("React", React);
});

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  layout.compact = false;
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function mount(node: ReactNode, width: number): HTMLDivElement {
  const container = document.createElement("div");
  container.style.width = `${width}px`;
  document.body.style.margin = "0";
  document.body.style.width = `${width}px`;
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

const NOOP = () => undefined;

function ReadyContentHarness({ width }: { width: number }) {
  const [featureFilter, setFeatureFilter] = React.useState<string | undefined>(undefined);
  const style = React.useMemo(() => ({ width }), [width]);
  return (
    <div style={style}>
      <JevDashboardReadyContent
        summary={JEV_SAVINGS_SUMMARY_FIXTURES.today}
        isLoading={false}
        events={JEV_SAVINGS_EVENTS_FIXTURE}
        isLoadingEvents={false}
        isLoadingMoreEvents={false}
        hasMoreEvents
        onLoadMoreEvents={NOOP}
        range="today"
        onRangeChange={NOOP}
        featureFilter={featureFilter}
        onFeatureFilterChange={setFeatureFilter}
        onOpenAgent={NOOP}
        onOpenWorkspace={NOOP}
      />
    </div>
  );
}

describe("resolveJevDashboardAvailability", () => {
  it("is no-host without a host, even connected", () => {
    expect(
      resolveJevDashboardAvailability({
        hasHost: false,
        connected: true,
        supportsJev: true,
        supportsSavings: true,
        keyPresent: true,
      }),
    ).toEqual({ kind: "no-host" });
  });

  it("is connecting for a host that hasn't connected yet", () => {
    expect(
      resolveJevDashboardAvailability({
        hasHost: true,
        connected: false,
        supportsJev: true,
        supportsSavings: true,
        keyPresent: null,
      }),
    ).toEqual({ kind: "connecting" });
  });

  it("is update-host when either jev or jevSavings is unsupported", () => {
    expect(
      resolveJevDashboardAvailability({
        hasHost: true,
        connected: true,
        supportsJev: true,
        supportsSavings: false,
        keyPresent: null,
      }),
    ).toEqual({ kind: "update-host" });
    expect(
      resolveJevDashboardAvailability({
        hasHost: true,
        connected: true,
        supportsJev: false,
        supportsSavings: true,
        keyPresent: null,
      }),
    ).toEqual({ kind: "update-host" });
  });

  it("is not-configured when the host has no key, but still ready to show the ledger", () => {
    expect(
      resolveJevDashboardAvailability({
        hasHost: true,
        connected: true,
        supportsJev: true,
        supportsSavings: true,
        keyPresent: false,
      }),
    ).toEqual({ kind: "not-configured" });
  });

  it("is ready when connected, supported, and keyed", () => {
    expect(
      resolveJevDashboardAvailability({
        hasHost: true,
        connected: true,
        supportsJev: true,
        supportsSavings: true,
        keyPresent: true,
      }),
    ).toEqual({ kind: "ready" });
  });
});

const READY_AVAILABILITY: JevDashboardAvailability = { kind: "ready" };
const UPDATE_HOST_AVAILABILITY: JevDashboardAvailability = { kind: "update-host" };
const NOT_CONFIGURED_AVAILABILITY: JevDashboardAvailability = { kind: "not-configured" };

describe("NotConfiguredBanner", () => {
  it("renders nothing when ready", () => {
    const container = mount(<NotConfiguredBanner availability={READY_AVAILABILITY} />, PHONE_WIDTH);
    expect(container.textContent).toBe("");
  });

  it("names the host update for an older daemon", () => {
    const container = mount(
      <NotConfiguredBanner availability={UPDATE_HOST_AVAILABILITY} />,
      PHONE_WIDTH,
    );
    expect(container.textContent).toContain("Update the host");
  });

  it("says nothing is sent yet when the host has no key", () => {
    const container = mount(
      <NotConfiguredBanner availability={NOT_CONFIGURED_AVAILABILITY} />,
      PHONE_WIDTH,
    );
    expect(container.textContent).toContain("not configured");
  });
});

describe("JevDashboardReadyContent", () => {
  it("shows the four tiles, never summing shadow into live", () => {
    const container = mount(<ReadyContentHarness width={DESKTOP_WIDTH} />, DESKTOP_WIDTH);
    expect(container.querySelector('[data-testid="jev-dashboard-tile-saved"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="jev-dashboard-tile-would-have-saved"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="jev-dashboard-tile-cost"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="jev-dashboard-tile-net"]')).not.toBeNull();
  });

  it("lists every known feature in order, including one the fixture state marks dormant", () => {
    const container = mount(<ReadyContentHarness width={DESKTOP_WIDTH} />, DESKTOP_WIDTH);
    const rows = Array.from(
      container
        .querySelector('[data-testid="jev-dashboard-feature-table"]')
        ?.querySelectorAll('[data-testid^="jev-dashboard-feature-"]') ?? [],
    );
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
      "jev-dashboard-feature-spawnHint",
      "jev-dashboard-feature-remediationTriage",
      "jev-dashboard-feature-notificationTriage",
      "jev-dashboard-feature-agentTools",
      "jev-dashboard-feature-compactionTiming",
      "jev-dashboard-feature-stallJudgment",
      "jev-dashboard-feature-awayReply",
      "jev-dashboard-feature-askJev",
      "jev-dashboard-feature-readCheck",
      "jev-dashboard-feature-titleRefresh",
    ]);
    expect(
      container.querySelector('[data-testid="jev-dashboard-feature-compactionTiming"]')
        ?.textContent,
    ).toContain("Dormant");
    expect(
      container.querySelector('[data-testid="jev-dashboard-feature-awayReply"]')?.textContent,
    ).toContain("Dry run");
  });

  it("reports the tapped feature to the filter, and clears on a second tap", () => {
    const onFeatureFilterChange = vi.fn();
    const container = mount(
      <JevDashboardReadyContent
        summary={JEV_SAVINGS_SUMMARY_FIXTURES.today}
        isLoading={false}
        events={JEV_SAVINGS_EVENTS_FIXTURE}
        isLoadingEvents={false}
        isLoadingMoreEvents={false}
        hasMoreEvents={false}
        onLoadMoreEvents={NOOP}
        range="today"
        onRangeChange={NOOP}
        featureFilter={undefined}
        onFeatureFilterChange={onFeatureFilterChange}
        onOpenAgent={NOOP}
        onOpenWorkspace={NOOP}
      />,
      DESKTOP_WIDTH,
    );
    const row = container.querySelector<HTMLElement>(
      '[data-testid="jev-dashboard-feature-agentTools"]',
    );
    expect(row).not.toBeNull();
    act(() => row?.click());
    expect(onFeatureFilterChange).toHaveBeenCalledWith("agentTools");
  });

  it("opens an agent from the top agents list", () => {
    const onOpenAgent = vi.fn();
    const container = mount(
      <JevDashboardReadyContent
        summary={JEV_SAVINGS_SUMMARY_FIXTURES.today}
        isLoading={false}
        events={JEV_SAVINGS_EVENTS_FIXTURE}
        isLoadingEvents={false}
        isLoadingMoreEvents={false}
        hasMoreEvents={false}
        onLoadMoreEvents={NOOP}
        range="today"
        onRangeChange={NOOP}
        featureFilter={undefined}
        onFeatureFilterChange={NOOP}
        onOpenAgent={onOpenAgent}
        onOpenWorkspace={NOOP}
      />,
      DESKTOP_WIDTH,
    );
    // The fixture's first top agent, by its accessibility label.
    const row = container
      .querySelector('[data-testid="jev-dashboard-top-agents"]')
      ?.querySelector('[aria-label="fix sidebar hover regression"]');
    expect(row).not.toBeNull();
    act(() => (row as HTMLElement).click());
    expect(onOpenAgent).toHaveBeenCalledWith("fx_agent_mobile_bugfix", null);
  });

  it("asks for more events when 'Load more' is pressed", () => {
    const onLoadMoreEvents = vi.fn();
    const container = mount(
      <JevDashboardReadyContent
        summary={JEV_SAVINGS_SUMMARY_FIXTURES.today}
        isLoading={false}
        events={JEV_SAVINGS_EVENTS_FIXTURE}
        isLoadingEvents={false}
        isLoadingMoreEvents={false}
        hasMoreEvents
        onLoadMoreEvents={onLoadMoreEvents}
        range="today"
        onRangeChange={NOOP}
        featureFilter={undefined}
        onFeatureFilterChange={NOOP}
        onOpenAgent={NOOP}
        onOpenWorkspace={NOOP}
      />,
      DESKTOP_WIDTH,
    );
    const loadMore = container.querySelector<HTMLElement>(
      '[data-testid="jev-dashboard-load-more"]',
    );
    expect(loadMore).not.toBeNull();
    act(() => loadMore?.click());
    expect(onLoadMoreEvents).toHaveBeenCalledTimes(1);
  });

  it("shows a loading row before the first summary arrives", () => {
    const container = mount(
      <JevDashboardReadyContent
        summary={undefined}
        isLoading
        events={[]}
        isLoadingEvents
        isLoadingMoreEvents={false}
        hasMoreEvents={false}
        onLoadMoreEvents={NOOP}
        range="today"
        onRangeChange={NOOP}
        featureFilter={undefined}
        onFeatureFilterChange={NOOP}
        onOpenAgent={NOOP}
        onOpenWorkspace={NOOP}
      />,
      DESKTOP_WIDTH,
    );
    expect(container.textContent).toContain("Loading");
  });

  it.each([
    { name: "phone", width: PHONE_WIDTH, compact: true },
    { name: "desktop", width: DESKTOP_WIDTH, compact: false },
  ])("captures the ready content on $name", async ({ name, width, compact }) => {
    layout.compact = compact;
    await page.viewport(width, 2600);
    const container = mount(<ReadyContentHarness width={width} />, width);
    await page.screenshot({
      element: container,
      path: `../../../../.artifacts/jev-dashboard-ready-${name}.png`,
    });
  });
});
