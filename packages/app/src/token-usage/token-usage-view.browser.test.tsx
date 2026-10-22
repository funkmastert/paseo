import React from "react";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Side-effecting: creating the instance is what registers it with react-i18next.
// eslint-disable-next-line import/no-unassigned-import
import "@/i18n/i18next";
import { ContentHarness, mount, unmountAll } from "./test-support/content-harness";

const PHONE_WIDTH = 390;
const NARROW_PHONE_WIDTH = 360;
const DESKTOP_WIDTH = 900;

// TokenUsageContent's JSX compiles under the classic transform (expo/tsconfig.base's
// `jsx: "react-native"`) but its own module never imports React by name, so its compiled
// `React.createElement` calls resolve to the global instead (jev-dashboard-view.browser.test.tsx
// uses the same stub). Without it, rendering it throws `ReferenceError: React is not defined`.
beforeEach(() => {
  vi.stubGlobal("React", React);
});

afterEach(() => {
  unmountAll();
});

/**
 * Screenshot capture only — real-browser pixels that the jsdom suite
 * (token-usage-content.test.tsx) can't produce. Behavioral assertions live there, sharing this
 * harness, so they run without needing a real browser.
 */
describe("TokenUsageContent screenshots", () => {
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

describe("TokensByModelCard narrow layout", () => {
  it("keeps the bar track visible instead of squeezed out by the cost line at 360px", async () => {
    await page.viewport(NARROW_PHONE_WIDTH, 1400);
    const container = mount(<ContentHarness width={NARROW_PHONE_WIDTH} />, NARROW_PHONE_WIDTH);
    const track = container.querySelector(
      '[data-testid="tokens-by-model-bar-claude/claude-opus-5-5"]',
    );
    const cost = container.querySelector(
      '[data-testid="tokens-by-model-cost-claude/claude-opus-5-5"]',
    );
    expect(track).not.toBeNull();
    expect(cost).not.toBeNull();
    // The bug this guards against: the cost text sat in the same fixed-width column as the token
    // total, so a longer "≥$X" lower-bound string squeezed the bar track toward zero width.
    expect(track!.getBoundingClientRect().width).toBeGreaterThan(20);
    // The cost line sits below the row, not crammed beside the track — it spans close to the
    // row's own width rather than a narrow fixed column.
    expect(cost!.getBoundingClientRect().width).toBeGreaterThan(50);
  });
});
