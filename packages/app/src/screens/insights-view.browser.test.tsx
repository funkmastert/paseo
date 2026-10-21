import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompactionEpisode } from "@/compactions/use-compaction-episodes";
// Side-effecting: creating the instance is what registers it with react-i18next.
// eslint-disable-next-line import/no-unassigned-import
import "@/i18n/i18next";
import {
  InsightsReadyContent,
  InsightsAvailabilityBanner,
  resolveInsightsAvailability,
  type InsightsAvailability,
} from "./insights-view";

const PHONE_WIDTH = 390;
const DESKTOP_WIDTH = 900;
const DESKTOP_WIDTH_STYLE = { width: DESKTOP_WIDTH };

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

const SUMMARY_FIXTURE = {
  count: 3,
  totalCostWeightedTokens: 525,
  averageCostWeightedTokens: 175,
  totalEstimatedSavedWeightedTokens: 114_000,
  measuredCount: 2,
  unmeasuredCount: 1,
};

const EPISODES_FIXTURE: CompactionEpisode[] = [
  {
    id: "leader-1:3000",
    agentId: "leader-1",
    agentTitle: "Ship the thing",
    source: "monitor",
    trigger: "line",
    triggerReason: null,
    startedAtMs: 3000,
    endedAtMs: 3700,
    steps: [],
    contextBeforeTokens: 612_000,
    contextAfterTokens: 31_000,
    outcome: "done",
    noteLength: 120,
    costWeightedTokens: 175,
    costBasis: "measured",
    estimatedSavedWeightedTokens: 38_000,
  },
  {
    id: "leader-2:2000",
    agentId: "leader-2",
    agentTitle: null,
    source: "backfill",
    trigger: "unknown",
    triggerReason: null,
    startedAtMs: 2000,
    endedAtMs: 2500,
    steps: [],
    contextBeforeTokens: 500_000,
    contextAfterTokens: 20_000,
    outcome: "done",
    noteLength: null,
    costWeightedTokens: null,
    costBasis: "unmeasured",
    estimatedSavedWeightedTokens: null,
  },
];

function ReadyContentHarness({
  width,
  episodes,
}: {
  width: number;
  episodes: CompactionEpisode[];
}) {
  const style = React.useMemo(() => ({ width }), [width]);
  return (
    <div style={style}>
      <InsightsReadyContent
        summary={SUMMARY_FIXTURE}
        isLoadingSummary={false}
        episodes={episodes}
        isLoadingEpisodes={false}
        isLoadingMoreEpisodes={false}
        hasMoreEpisodes
        onLoadMoreEpisodes={NOOP}
        range="today"
        onRangeChange={NOOP}
        onOpenJevDashboard={NOOP}
        onOpenDecisions={NOOP}
        onOpenTokenUsage={NOOP}
      />
    </div>
  );
}

describe("resolveInsightsAvailability", () => {
  it("is no-host without a host, even connected", () => {
    expect(
      resolveInsightsAvailability({ hasHost: false, connected: true, supported: true }),
    ).toEqual({ kind: "no-host" });
  });

  it("is connecting for a host that hasn't connected yet", () => {
    expect(
      resolveInsightsAvailability({ hasHost: true, connected: false, supported: true }),
    ).toEqual({ kind: "connecting" });
  });

  it("is update-host for a daemon older than the feature", () => {
    expect(
      resolveInsightsAvailability({ hasHost: true, connected: true, supported: false }),
    ).toEqual({ kind: "update-host" });
  });

  it("is ready when connected and supported", () => {
    expect(
      resolveInsightsAvailability({ hasHost: true, connected: true, supported: true }),
    ).toEqual({ kind: "ready" });
  });
});

const READY_AVAILABILITY: InsightsAvailability = { kind: "ready" };
const UPDATE_HOST_AVAILABILITY: InsightsAvailability = { kind: "update-host" };

describe("InsightsAvailabilityBanner", () => {
  it("renders nothing when ready", () => {
    const container = mount(
      <InsightsAvailabilityBanner availability={READY_AVAILABILITY} />,
      PHONE_WIDTH,
    );
    expect(container.textContent).toBe("");
  });

  it("names the host update for an older daemon", () => {
    const container = mount(
      <InsightsAvailabilityBanner availability={UPDATE_HOST_AVAILABILITY} />,
      PHONE_WIDTH,
    );
    expect(container.textContent).toContain("Update the host");
  });
});

describe("InsightsReadyContent", () => {
  it("shows the four totals tiles", () => {
    const container = mount(
      <ReadyContentHarness width={DESKTOP_WIDTH} episodes={EPISODES_FIXTURE} />,
      DESKTOP_WIDTH,
    );
    expect(container.querySelector('[data-testid="insights-tile-count"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="insights-tile-total-cost"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="insights-tile-average-cost"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="insights-tile-estimated-saved"]')).not.toBeNull();
  });

  it("shows the three dashboard links regardless of filter state", () => {
    const container = mount(
      <ReadyContentHarness width={DESKTOP_WIDTH} episodes={EPISODES_FIXTURE} />,
      DESKTOP_WIDTH,
    );
    const links = container.querySelector('[data-testid="insights-dashboard-links"]');
    expect(links?.textContent).toContain("JEV dashboard");
    expect(links?.textContent).toContain("Decisions");
    expect(links?.textContent).toContain("Token usage");
  });

  it("renders a measured episode's numeric cost and an unmeasured one's plain label", () => {
    const container = mount(
      <ReadyContentHarness width={DESKTOP_WIDTH} episodes={EPISODES_FIXTURE} />,
      DESKTOP_WIDTH,
    );
    const measuredRow = container.querySelector(
      '[data-testid="insights-compaction-leader-1:3000"]',
    );
    expect(measuredRow?.textContent).toContain("Cost 175");
    const unmeasuredRow = container.querySelector(
      '[data-testid="insights-compaction-leader-2:2000"]',
    );
    expect(unmeasuredRow?.textContent).toContain("not measured");
  });

  it("renders newest first", () => {
    const container = mount(
      <ReadyContentHarness width={DESKTOP_WIDTH} episodes={EPISODES_FIXTURE} />,
      DESKTOP_WIDTH,
    );
    const rows = Array.from(
      container
        .querySelector('[data-testid="insights-compaction-list"]')
        ?.querySelectorAll('[data-testid^="insights-compaction-leader-"]') ?? [],
    );
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
      "insights-compaction-leader-1:3000",
      "insights-compaction-leader-2:2000",
    ]);
  });

  it("renders the design system's empty state for no episodes", () => {
    const container = mount(
      <ReadyContentHarness width={DESKTOP_WIDTH} episodes={[]} />,
      DESKTOP_WIDTH,
    );
    expect(container.querySelector('[data-testid="insights-compaction-empty"]')?.textContent).toBe(
      "No compactions yet",
    );
  });

  it("asks for more episodes when 'Load more' is pressed", () => {
    const onLoadMoreEpisodes = vi.fn();
    const container = mount(
      <div style={DESKTOP_WIDTH_STYLE}>
        <InsightsReadyContent
          summary={SUMMARY_FIXTURE}
          isLoadingSummary={false}
          episodes={EPISODES_FIXTURE}
          isLoadingEpisodes={false}
          isLoadingMoreEpisodes={false}
          hasMoreEpisodes
          onLoadMoreEpisodes={onLoadMoreEpisodes}
          range="today"
          onRangeChange={NOOP}
          onOpenJevDashboard={NOOP}
          onOpenDecisions={NOOP}
          onOpenTokenUsage={NOOP}
        />
      </div>,
      DESKTOP_WIDTH,
    );
    const loadMore = container.querySelector<HTMLElement>('[data-testid="insights-load-more"]');
    expect(loadMore).not.toBeNull();
    act(() => loadMore?.click());
    expect(onLoadMoreEpisodes).toHaveBeenCalledTimes(1);
  });

  it("opens the JEV dashboard link", () => {
    const onOpenJevDashboard = vi.fn();
    const container = mount(
      <div style={DESKTOP_WIDTH_STYLE}>
        <InsightsReadyContent
          summary={SUMMARY_FIXTURE}
          isLoadingSummary={false}
          episodes={EPISODES_FIXTURE}
          isLoadingEpisodes={false}
          isLoadingMoreEpisodes={false}
          hasMoreEpisodes={false}
          onLoadMoreEpisodes={NOOP}
          range="today"
          onRangeChange={NOOP}
          onOpenJevDashboard={onOpenJevDashboard}
          onOpenDecisions={NOOP}
          onOpenTokenUsage={NOOP}
        />
      </div>,
      DESKTOP_WIDTH,
    );
    const link = container.querySelector<HTMLElement>('[aria-label="JEV dashboard"]');
    expect(link).not.toBeNull();
    act(() => link?.click());
    expect(onOpenJevDashboard).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "phone", width: PHONE_WIDTH, compact: true },
    { name: "desktop", width: DESKTOP_WIDTH, compact: false },
  ])("captures the ready content on $name", async ({ name, width, compact }) => {
    layout.compact = compact;
    await page.viewport(width, 1800);
    const container = mount(
      <ReadyContentHarness width={width} episodes={EPISODES_FIXTURE} />,
      width,
    );
    await page.screenshot({
      element: container,
      path: `../../../../.artifacts/insights-ready-${name}.png`,
    });
  });

  it("captures the empty state", async () => {
    await page.viewport(DESKTOP_WIDTH, 900);
    const container = mount(
      <ReadyContentHarness width={DESKTOP_WIDTH} episodes={[]} />,
      DESKTOP_WIDTH,
    );
    await page.screenshot({
      element: container,
      path: "../../../../.artifacts/insights-ready-empty.png",
    });
  });
});
