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

const EPISODE: CompactionEpisode = {
  id: "leader-1:1000",
  agentId: "leader-1",
  agentTitle: "Ship the thing",
  source: "monitor",
  trigger: "line",
  triggerReason: null,
  startedAtMs: 1000,
  endedAtMs: 1700,
  steps: [
    {
      step: "prepare",
      startedAtMs: 1000,
      endedAtMs: 1100,
      outcome: "completed",
      costWeightedTokens: 50,
    },
    {
      step: "compact",
      startedAtMs: 1200,
      endedAtMs: 1500,
      outcome: "completed",
      costWeightedTokens: 100,
    },
    {
      step: "restore",
      startedAtMs: 1600,
      endedAtMs: 1700,
      outcome: "completed",
      costWeightedTokens: 25,
    },
  ],
  contextBeforeTokens: 612_000,
  contextAfterTokens: 31_000,
  outcome: "done",
  noteLength: 120,
  costWeightedTokens: 175,
  costBasis: "measured",
  estimatedSavedWeightedTokens: 38_000,
};

const EPISODE_WITH_QUIET_GATE: CompactionEpisode = {
  ...EPISODE,
  quietGate: { quietMinutes: 5, ceilingTokens: 450_000 },
  promptsCarried: 2,
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
      expect(body).toContain("Payback");
      expect(body).toContain("Done");
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

  it("shows the quiet-gate wait and carried-prompt count only when present", async () => {
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
      expect(body).toContain("Waited 5m quiet");
      expect(body).toContain("2 prompts carried");
    });
  });

  it.each([
    { name: "phone", width: PHONE_WIDTH },
    { name: "desktop", width: DESKTOP_WIDTH },
  ])("captures the popover open on $name", async ({ name, width }) => {
    await page.viewport(width, 600);
    const container = mount(
      <CompactionMarkerPopover episode={EPISODE}>
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
