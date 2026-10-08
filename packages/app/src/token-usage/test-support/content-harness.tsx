import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  buildTokenUsageBackfillingFixture,
  buildTokenUsageDisabledFixture,
  buildTokenUsageErrorFixture,
  buildTokenUsageFixture,
} from "../token-usage-fixtures";
import { TokenUsageContent } from "../token-usage-view";

/**
 * Shared DOM-mount harness for `TokenUsageContent`, used by both the jsdom assertion suite
 * (token-usage-content.test.tsx) and the real-browser screenshot suite
 * (token-usage-view.browser.test.tsx) — one harness, two runners.
 */

export const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

export function unmountAll(): void {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
}

export function mount(node: React.ReactNode, width: number): HTMLDivElement {
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

export const NOOP = () => undefined;

export type HarnessVariant =
  | "data"
  | "backfilling"
  | "error"
  | "disabled"
  | "loading"
  | "query-error";

function breakdownFor(variant: HarnessVariant) {
  switch (variant) {
    case "backfilling":
      return buildTokenUsageBackfillingFixture("7d");
    case "error":
      return buildTokenUsageErrorFixture("7d");
    case "disabled":
      return buildTokenUsageDisabledFixture("7d");
    case "loading":
    case "query-error":
      return undefined;
    case "data":
      return buildTokenUsageFixture("7d");
  }
}

export function ContentHarness({
  width,
  variant = "data",
  onRetry = NOOP,
}: {
  width: number;
  variant?: HarnessVariant;
  onRetry?: () => void;
}) {
  const breakdown = breakdownFor(variant);
  const style = React.useMemo(() => ({ width }), [width]);
  return (
    <div style={style}>
      <TokenUsageContent
        breakdown={breakdown}
        isLoading={variant === "loading"}
        queryError={variant === "query-error" ? new Error("network unreachable") : null}
        onRetry={onRetry}
        unit="weighted"
        onUnitChange={NOOP}
        range="7d"
        onRangeChange={NOOP}
      />
    </div>
  );
}
