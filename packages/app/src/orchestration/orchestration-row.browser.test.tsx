import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { View } from "react-native";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrchestrationRow } from "./orchestration-row";
import { buildOrchestrationFixtureRows, FIXTURE_NOW_MS } from "./fixture-fleet";
import { useTokenBurnTones } from "@/hooks/use-token-burn-tones";
// Side-effecting: creating the instance is what registers it with react-i18next, so the rows
// render their real copy rather than raw keys.
// eslint-disable-next-line import/no-unassigned-import
import "@/i18n/i18next";
import type { TokenBurnSibling } from "@/utils/token-burn-tone-model";

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
const noop = () => undefined;

function Fleet({ slice, canShowActivity }: { slice: [number, number]; canShowActivity: boolean }) {
  const rows = buildOrchestrationFixtureRows().slice(slice[0], slice[1]);
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
