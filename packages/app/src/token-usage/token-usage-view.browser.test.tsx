import { page } from "vitest/browser";
import { afterEach, describe, it } from "vitest";
// Side-effecting: creating the instance is what registers it with react-i18next.
// eslint-disable-next-line import/no-unassigned-import
import "@/i18n/i18next";
import { ContentHarness, mount, unmountAll } from "./test-support/content-harness";

const PHONE_WIDTH = 390;
const DESKTOP_WIDTH = 900;

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
