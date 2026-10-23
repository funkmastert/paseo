import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Text } from "react-native";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Side-effecting: creating the instance is what registers it with react-i18next.
// eslint-disable-next-line import/no-unassigned-import
import "@/i18n/i18next";
import { CompactionMarkerPopover } from "./compaction-marker-popover";
import type { CompactionEpisode } from "./use-compaction-episodes";

const PHONE_WIDTH = 390;
const DESKTOP_WIDTH = 900;

// The unistyles stub has no runtime, so the real hook never reports a compact form factor
// (jev-dashboard-view.browser.test.tsx uses the same mock). Tooltip's openOnPress depends on it.
const layout = vi.hoisted(() => ({ compact: false }));
vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => layout.compact,
}));

// The tooltip's 80 ms fade is a CSS animation on web. A screenshot paints it, and Reanimated's web
// layout-animation start handler then throws here (`_updatePropsJS` on a DOM node with no props),
// an unhandled error that fails the run. The fade is not under test; drop it in this file.
vi.mock("react-native-reanimated", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native-reanimated")>();
  const noAnimation = { duration: () => undefined };
  return { ...actual, FadeIn: noAnimation, FadeOut: noAnimation };
});

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

// A real afternoon, not epoch-adjacent fixtures: the clock times render as they would for Tyler.
const T0 = new Date(2026, 9, 21, 14, 2, 0).getTime();
const SECOND = 1000;
const MINUTE = 60 * SECOND;

const EPISODE: CompactionEpisode = {
  id: `leader-1:${T0}`,
  agentId: "leader-1",
  agentTitle: "Ship the thing",
  source: "monitor",
  trigger: "line",
  triggerReason: null,
  startedAtMs: T0,
  endedAtMs: T0 + 4 * MINUTE + 5 * SECOND,
  steps: [
    {
      step: "prepare",
      startedAtMs: T0,
      endedAtMs: T0 + 48 * SECOND,
      outcome: "completed",
      costWeightedTokens: 3_100,
    },
    {
      step: "compact",
      startedAtMs: T0 + MINUTE,
      endedAtMs: T0 + 3 * MINUTE + 10 * SECOND,
      outcome: "completed",
      costWeightedTokens: 18_400,
    },
    {
      step: "restore",
      startedAtMs: T0 + 3 * MINUTE + 20 * SECOND,
      endedAtMs: T0 + 4 * MINUTE + 5 * SECOND,
      outcome: "completed",
      costWeightedTokens: 2_200,
    },
  ],
  contextBeforeTokens: 612_000,
  contextAfterTokens: 31_000,
  outcome: "done",
  noteLength: 1_840,
  costWeightedTokens: 23_700,
  costBasis: "measured",
  estimatedSavedWeightedTokens: 1_220_000,
};

const EPISODE_WITH_QUIET_GATE: CompactionEpisode = {
  ...EPISODE,
  quietGate: { heldFromMs: T0 - 7 * MINUTE, heldUntilMs: T0, heldMs: 7 * MINUTE },
  promptsCarried: [
    { atMs: T0 - 8 * MINUTE, text: "also fix the login bug on the settings page" },
    { atMs: T0 + 2 * MINUTE, text: "please check the CI run on PR 41 when you're back" },
  ],
};

const EPISODE_WITH_SHARED_STEP: CompactionEpisode = {
  ...EPISODE,
  costWeightedTokens: null,
  costBasis: "unmeasured",
  steps: EPISODE.steps.map((step) =>
    step.step === "prepare" ? { ...step, costWeightedTokens: null, steeredIn: 1 } : step,
  ),
};

function Marker() {
  return <Text testID="compaction-marker-row">612.0k → 31.0k tokens</Text>;
}

describe("CompactionMarkerPopover", () => {
  it("opens with every step's duration and cost, and the payback estimate, on hover (desktop)", async () => {
    const container = mount(
      <CompactionMarkerPopover episode={EPISODE}>
        <Marker />
      </CompactionMarkerPopover>,
      DESKTOP_WIDTH,
    );
    const trigger = container.querySelector(
      '[data-testid="compaction-marker-trigger"]',
    ) as HTMLElement;
    expect(trigger).not.toBeNull();
    act(() => {
      trigger.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    });
    await vi.waitFor(() => {
      const body = document.body.textContent ?? "";
      expect(body).toContain("prepare");
      expect(body).toContain("compact");
      expect(body).toContain("restore");
      expect(body).toContain("Done");
      expect(body).toContain("3,100");
      expect(body).toContain("18.4k");
      expect(body).toContain("2,200");
      expect(body).toContain("Payback ~1.2M est.");
      expect(body).not.toContain("for quiet");
      expect(body).not.toContain("carried");
    });
  });

  it("opens on a tap (phone)", async () => {
    layout.compact = true;
    const container = mount(
      <CompactionMarkerPopover episode={EPISODE}>
        <Marker />
      </CompactionMarkerPopover>,
      PHONE_WIDTH,
    );
    const trigger = container.querySelector(
      '[data-testid="compaction-marker-trigger"]',
    ) as HTMLElement;
    act(() => trigger.click());
    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("Payback");
    });
  });

  it("shows the quiet-gate wait and the carried prompts' text", async () => {
    const container = mount(
      <CompactionMarkerPopover episode={EPISODE_WITH_QUIET_GATE}>
        <Marker />
      </CompactionMarkerPopover>,
      DESKTOP_WIDTH,
    );
    const trigger = container.querySelector(
      '[data-testid="compaction-marker-trigger"]',
    ) as HTMLElement;
    act(() => {
      trigger.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    });
    await vi.waitFor(() => {
      const body = document.body.textContent ?? "";
      expect(body).toContain("Waited 7m for quiet");
      expect(body).toContain("2 prompts carried");
      expect(body).toContain("also fix the login bug on the settings page");
      expect(body).toContain("please check the CI run on PR 41 when you're back");
    });
  });

  it("says why a step another message joined has no cost", async () => {
    const container = mount(
      <CompactionMarkerPopover episode={EPISODE_WITH_SHARED_STEP}>
        <Marker />
      </CompactionMarkerPopover>,
      DESKTOP_WIDTH,
    );
    const trigger = container.querySelector(
      '[data-testid="compaction-marker-trigger"]',
    ) as HTMLElement;
    act(() => {
      trigger.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("not measured: 1 message joined");
    });
  });

  it.each([
    { name: "phone", width: PHONE_WIDTH },
    { name: "desktop", width: DESKTOP_WIDTH },
  ])("captures the popover open on $name", async ({ name, width }) => {
    await page.viewport(width, 600);
    const container = mount(
      <CompactionMarkerPopover episode={EPISODE_WITH_QUIET_GATE}>
        <Marker />
      </CompactionMarkerPopover>,
      width,
    );
    const trigger = container.querySelector(
      '[data-testid="compaction-marker-trigger"]',
    ) as HTMLElement;
    act(() => {
      trigger.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("Payback");
    });
    await page.screenshot({
      path: `../../../../.artifacts/compaction-marker-popover-${name}.png`,
    });
  });
});
