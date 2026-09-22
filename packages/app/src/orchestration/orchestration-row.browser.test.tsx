import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { View } from "react-native";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrchestrationRow } from "./orchestration-row";
import { OrchestrationHeaderControls } from "./orchestration-header-controls";
import {
  buildOrchestrationFixtureRows,
  FIXTURE_NOW_MS,
  sliceOrchestrationFixtureTree,
} from "./fixture-fleet";
import { selectVisibleOrchestrationRows } from "./orchestration-visibility";
import { useTokenBurnTones } from "@/hooks/use-token-burn-tones";
// Side-effecting: creating the instance is what registers it with react-i18next, so the rows
// render their real copy rather than raw keys.
// eslint-disable-next-line import/no-unassigned-import
import "@/i18n/i18next";
import type { TokenBurnSibling } from "@/utils/token-burn-tone-model";
import type { OrchestrationFlatRow } from "./orchestration-panel-model";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(FIXTURE_NOW_MS);
});

afterEach(() => {
  vi.useRealTimers();
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

/**
 * The orchestration list at fleet scale, in a real browser, as a screenshot.
 *
 * The panel's presentation only has a problem at size — a handful of running agents among fifty
 * finished ones — and no daemon is reliably in that shape when someone wants to look at it. The
 * fixture fleet is modelled on a measured one (see fixture-fleet.ts) so the picture is comparable
 * across changes. The rows are the whole design surface; the panel shell around them is a header
 * and a FlatList, and the header's budget strip needs a live host to render at all.
 */
interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];
const PANEL_WIDTH = 340;

function mount(node: ReactNode, width = PANEL_WIDTH): HTMLDivElement {
  const container = document.createElement("div");
  container.style.width = `${width}px`;
  document.body.style.margin = "0";
  document.body.style.width = `${width}px`;
  document.body.style.background = "#fff";
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

const listStyle = { paddingVertical: 8 } as const;
const headerStyle = { paddingHorizontal: 12, paddingVertical: 12, gap: 12 } as const;
const noop = () => undefined;
const IDLE_ARCHIVE = { kind: "idle" } as const;
const SCOPED_ROOT_TITLE = "Relaunch app on device for pull-to-refresh test";

function Rows({
  rows,
  canShowActivity,
}: {
  rows: OrchestrationFlatRow[];
  canShowActivity: boolean;
}) {
  const siblings: TokenBurnSibling[] = rows.map((row) => ({
    id: row.agent.id,
    recentTokenRate: row.agent.recentTokenRate,
  }));
  const tones = useTokenBurnTones(siblings);
  return (
    <View style={listStyle}>
      {rows.map((row) => (
        <OrchestrationRow
          key={row.agent.id}
          row={row}
          serverId="fixture-host"
          canDetach
          canShowActivity={canShowActivity}
          tokenBurnTone={tones.get(row.agent.id)}
          onPress={noop}
          onArchive={noop}
          onDetach={noop}
        />
      ))}
    </View>
  );
}

function Fleet({ slice, canShowActivity }: { slice: [number, number]; canShowActivity: boolean }) {
  const rows = buildOrchestrationFixtureRows().slice(slice[0], slice[1]);
  return <Rows rows={rows} canShowActivity={canShowActivity} />;
}

/**
 * The panel as it is actually shown: its own controls above the rows the default view keeps.
 *
 * The budget strip and the stale notice are excluded because both need a live host; everything
 * else the panel draws is here.
 */
function DefaultView({
  scope,
  rows,
  hiddenCount,
  isShowingOlder,
  canShowActivity,
}: {
  scope: "leader" | "all";
  rows: OrchestrationFlatRow[];
  hiddenCount: number;
  isShowingOlder: boolean;
  canShowActivity: boolean;
}) {
  return (
    <View>
      <View style={headerStyle}>
        <OrchestrationHeaderControls
          scope={scope}
          canScopeToLeader
          onScopeChange={noop}
          eligibleFinishedCount={rows.length}
          archiveFinishedStatus={IDLE_ARCHIVE}
          onArchiveFinished={noop}
          hiddenCount={hiddenCount}
          isShowingOlder={isShowingOlder}
          onToggleOlder={noop}
        />
      </View>
      <Rows rows={rows} canShowActivity={canShowActivity} />
    </View>
  );
}

// The runner's iframe is shorter than 53 rows, and anything below its fold captures blank, so
// the fleet is photographed in two halves rather than one tall image. It is photographed at two
// widths because the activity column is width-gated: the narrow one is a side pane, the wide one
// a main pane.
const CAPTURES: Array<{
  name: string;
  slice: [number, number];
  width: number;
  canShowActivity: boolean;
}> = [
  {
    name: "../../../../docs/assets/orchestration-panel-fleet-1.png",
    slice: [0, 27],
    width: PANEL_WIDTH,
    canShowActivity: false,
  },
  {
    name: "../../../../docs/assets/orchestration-panel-fleet-2.png",
    slice: [27, 53],
    width: PANEL_WIDTH,
    canShowActivity: false,
  },
  {
    name: "../../../../docs/assets/orchestration-panel-fleet-wide.png",
    slice: [0, 27],
    width: 440,
    canShowActivity: true,
  },
];

describe("orchestration rows at fleet scale", () => {
  it("renders every agent in the fleet", () => {
    const container = mount(<Fleet slice={[0, 53]} canShowActivity />);
    expect(container.querySelectorAll('[data-testid^="orchestration-row-"]').length).toBe(53);
  });

  it.each([
    { width: 340, canShowActivity: false },
    { width: 440, canShowActivity: true },
  ])("keeps every row inside a $width panel", ({ width, canShowActivity }) => {
    const container = mount(<Fleet slice={[0, 53]} canShowActivity={canShowActivity} />, width);
    const overflowing = Array.from(
      container.querySelectorAll('[data-testid^="orchestration-row-"]'),
    )
      .filter((row) => row.scrollWidth > row.clientWidth + 1)
      .map((row) => `${row.getAttribute("data-testid")}: ${row.scrollWidth}>${row.clientWidth}`);
    expect(overflowing).toEqual([]);
  });

  it.each(CAPTURES)("captures %#", async ({ name, slice, width, canShowActivity }) => {
    const container = mount(<Fleet slice={slice} canShowActivity={canShowActivity} />, width);
    await page.screenshot({ element: container, path: name });
  });
});

/**
 * What the panel actually puts on screen once the default view has done its filtering: the same
 * fixture fleet, scoped and pruned, beside the controls that say so. The unfiltered captures
 * above are the before.
 */
describe("orchestration default view", () => {
  const allRows = buildOrchestrationFixtureRows();
  const hostWide = selectVisibleOrchestrationRows(allRows, { nowMs: FIXTURE_NOW_MS });
  const scopedRows = sliceOrchestrationFixtureTree(allRows, SCOPED_ROOT_TITLE);
  const scoped = selectVisibleOrchestrationRows(scopedRows, { nowMs: FIXTURE_NOW_MS });

  it("cuts the fleet down to what is still moving", () => {
    expect(allRows.length).toBe(53);
    expect(hostWide.rows.length).toBeLessThan(allRows.length / 2);
    expect(hostWide.rows.length + hostWide.hiddenCount).toBe(allRows.length);
  });

  it("captures the host-wide default view", async () => {
    const container = mount(
      <DefaultView
        scope="all"
        rows={hostWide.rows}
        hiddenCount={hostWide.hiddenCount}
        isShowingOlder={false}
        canShowActivity={false}
      />,
    );
    await page.screenshot({
      element: container,
      path: "../../../../docs/assets/orchestration-panel-default.png",
    });
  });

  it("captures a tab scoped to one leader", async () => {
    const container = mount(
      <DefaultView
        scope="leader"
        rows={scoped.rows}
        hiddenCount={scoped.hiddenCount}
        isShowingOlder={false}
        canShowActivity={false}
      />,
    );
    await page.screenshot({
      element: container,
      path: "../../../../docs/assets/orchestration-panel-scoped.png",
    });
  });

  it("captures the same scoped tab with its older agents shown", async () => {
    const container = mount(
      <DefaultView
        scope="leader"
        rows={scopedRows}
        hiddenCount={0}
        isShowingOlder
        canShowActivity={false}
      />,
    );
    await page.screenshot({
      element: container,
      path: "../../../../docs/assets/orchestration-panel-scoped-older.png",
    });
  });
});
