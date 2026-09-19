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
const PANEL_WIDTH = 560;

function mount(node: ReactNode): HTMLDivElement {
  const container = document.createElement("div");
  container.style.width = `${PANEL_WIDTH}px`;
  document.body.style.margin = "0";
  document.body.style.width = `${PANEL_WIDTH}px`;
  document.body.style.background = "#fff";
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

const listStyle = { paddingVertical: 8 } as const;
const noop = () => undefined;

function Fleet({ slice }: { slice: [number, number] }) {
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
// the fleet is photographed in two halves rather than one tall image.
const HALVES: Array<{ name: string; slice: [number, number] }> = [
  { name: "../../../../docs/assets/orchestration-panel-fleet-1.png", slice: [0, 27] },
  { name: "../../../../docs/assets/orchestration-panel-fleet-2.png", slice: [27, 53] },
];

describe("orchestration rows at fleet scale", () => {
  it("renders every agent in the fleet", () => {
    const container = mount(<Fleet slice={[0, 53]} />);
    expect(container.querySelectorAll('[data-testid^="orchestration-row-"]').length).toBe(53);
  });

  it.each(HALVES)("captures %#", async ({ name, slice }) => {
    const container = mount(<Fleet slice={slice} />);
    await page.screenshot({ element: container, path: name });
  });
});
