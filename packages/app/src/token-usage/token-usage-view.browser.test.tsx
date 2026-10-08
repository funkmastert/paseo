import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { buildTokenUsageBackfillingFixture, buildTokenUsageFixture } from "./token-usage-fixtures";
import { TokenUsageContent } from "./token-usage-view";

const PHONE_WIDTH = 390;
const DESKTOP_WIDTH = 900;

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function mount(node: React.ReactNode, width: number): HTMLDivElement {
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

function ContentHarness({ width, backfilling = false }: { width: number; backfilling?: boolean }) {
  const breakdown = backfilling
    ? buildTokenUsageBackfillingFixture("7d")
    : buildTokenUsageFixture("7d");
  const style = React.useMemo(() => ({ width }), [width]);
  return (
    <div style={style}>
      <TokenUsageContent
        breakdown={breakdown}
        unit="weighted"
        onUnitChange={NOOP}
        range="7d"
        onRangeChange={NOOP}
      />
    </div>
  );
}

describe("TokenUsageContent", () => {
  it("shows the model and role cards with fixture data", () => {
    const container = mount(<ContentHarness width={DESKTOP_WIDTH} />, DESKTOP_WIDTH);
    expect(container.querySelector('[data-testid="tokens-by-model-card"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="tokens-by-role-card"]')).not.toBeNull();
  });

  it("trails the unattributed row and flags the footer", () => {
    const container = mount(<ContentHarness width={DESKTOP_WIDTH} />, DESKTOP_WIDTH);
    const rows = Array.from(container.querySelectorAll('[data-testid^="tokens-by-model-row-"]'));
    expect(rows.at(-1)?.getAttribute("data-testid")).toContain("unknown");
    expect(
      container.querySelector('[data-testid="token-usage-attribution-footer"]'),
    ).not.toBeNull();
  });

  it("shows the backfill progress banner with no rows yet", () => {
    const container = mount(<ContentHarness width={DESKTOP_WIDTH} backfilling />, DESKTOP_WIDTH);
    expect(container.querySelector('[data-testid="token-usage-backfilling"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="tokens-by-model-card"]')).toBeNull();
  });

  it.each([
    { name: "phone", width: PHONE_WIDTH },
    { name: "desktop", width: DESKTOP_WIDTH },
  ])("captures the ready content on $name", async ({ name, width }) => {
    await page.viewport(width, 1400);
    const container = mount(<ContentHarness width={width} />, width);
    await page.screenshot({
      element: container,
      path: `/tmp/token-usage-screens/token-usage-${name}.png`,
    });
  });
});
