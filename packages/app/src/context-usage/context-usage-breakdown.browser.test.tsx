import React, { act, useMemo, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Text, View } from "react-native";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContextUsage } from "@getpaseo/protocol/context-usage/rpc-schemas";
// Side-effecting: creating the instance is what registers it with react-i18next, so the section
// renders its real copy rather than raw keys.
// eslint-disable-next-line import/no-unassigned-import
import "@/i18n/i18next";
import {
  formatContextTokens,
  type AgentContextUsagePayload,
  resolveContextMeterThresholds,
  resolveContextMeterTone,
} from "./context-meter-model";
import { ContextUsageBreakdown } from "./context-usage-breakdown";
import haiku200k from "./test-fixtures/normalized-haiku-200k.json";
import opus1m from "./test-fixtures/normalized-opus-1m.json";

const opus = opus1m as AgentContextUsage;
const haiku = haiku200k as AgentContextUsage;
const thresholds = resolveContextMeterThresholds(undefined);

// The captures in the fixtures were taken at this moment; the popover reads "6m ago".
const NOW_MS = Date.parse("2026-09-24T23:27:54.742Z");

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW_MS);
});

afterEach(() => {
  vi.useRealTimers();
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

/**
 * The context meter's popover body in a real browser, as a screenshot.
 *
 * The meter itself needs a live host (daemon config, session store, query client) and the
 * unistyles stub has no SVG, so the ring is not in the picture. What is: the section that fills
 * the tooltip, under the same header lines the meter draws, in a frame with the tooltip's own
 * surface. Screenshots land in `.artifacts/` at the repo root.
 */
interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];
const PHONE_WIDTH = 390;
const DESKTOP_WIDTH = 720;
// The meter's tooltip width: 320, or the window less a margin on a narrower screen.
const TOOLTIP_MAX_WIDTH = 320;
const TOOLTIP_SCREEN_MARGIN = 32;

function mount(node: ReactNode, width: number): HTMLDivElement {
  const container = document.createElement("div");
  container.style.width = `${width}px`;
  container.style.padding = "16px 0";
  container.style.background = "#ececef";
  container.style.display = "flex";
  container.style.justifyContent = "center";
  document.body.style.margin = "0";
  document.body.style.width = `${width}px`;
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

const frameStyle = {
  paddingVertical: 4,
  paddingHorizontal: 8,
  borderRadius: 12,
  borderWidth: 1,
  borderColor: "#a1a1aa",
  backgroundColor: "#ffffff",
} as const;
const titleStyle = { fontSize: 16, color: "#111111" } as const;
const detailStyle = { fontSize: 14, color: "#666666", lineHeight: 19.6 } as const;

function scaleCategory(
  category: AgentContextUsage["categories"][number],
  factor: number,
  freeTokens: number,
): AgentContextUsage["categories"][number] {
  if (category.kind === "used")
    return { ...category, tokens: Math.round(category.tokens * factor) };
  if (category.kind === "free") return { ...category, tokens: freeTokens };
  return category;
}

function scaleUsage(usage: AgentContextUsage, factor: number): AgentContextUsage {
  const used = usage.categories
    .filter((category) => category.kind === "used")
    .reduce((sum, category) => sum + Math.round(category.tokens * factor), 0);
  const buffer = usage.categories.find((category) => category.kind === "buffer")?.tokens ?? 0;
  const freeTokens = Math.max(usage.maxTokens - used - buffer, 0);
  const breakdown = usage.messageBreakdown;
  return {
    ...usage,
    totalTokens: Math.round(usage.totalTokens * factor),
    categories: usage.categories.map((category) => scaleCategory(category, factor, freeTokens)),
    memoryFiles: usage.memoryFiles.map((file) => scaleMemoryFile(file, factor)),
    messageBreakdown: breakdown
      ? {
          toolCallTokens: Math.round(breakdown.toolCallTokens * factor),
          toolResultTokens: Math.round(breakdown.toolResultTokens * factor),
          attachmentTokens: Math.round(breakdown.attachmentTokens * factor),
          assistantMessageTokens: Math.round(breakdown.assistantMessageTokens * factor),
          userMessageTokens: Math.round(breakdown.userMessageTokens * factor),
        }
      : undefined,
  };
}

function scaleMemoryFile(
  file: AgentContextUsage["memoryFiles"][number],
  factor: number,
): AgentContextUsage["memoryFiles"][number] {
  return { ...file, tokens: Math.round(file.tokens * factor) };
}

function captured(usage: AgentContextUsage): AgentContextUsagePayload {
  return { requestId: "r", agentId: "a", status: "captured", usage, error: null };
}

function status(kind: string): AgentContextUsagePayload {
  return { requestId: "r", agentId: "a", status: kind, usage: null, error: null };
}

function Popover({
  usage,
  payload,
  isSupported = true,
  isLoading = false,
  width,
}: {
  usage: AgentContextUsage;
  payload: AgentContextUsagePayload | undefined;
  isSupported?: boolean;
  isLoading?: boolean;
  width: number;
}) {
  const tone = resolveContextMeterTone(
    { usedTokens: usage.totalTokens, maxTokens: usage.maxTokens },
    thresholds,
  );
  const percentage = Math.round((usage.totalTokens / usage.maxTokens) * 100);
  const innerWidth = Math.min(TOOLTIP_MAX_WIDTH, width - TOOLTIP_SCREEN_MARGIN);
  const innerStyle = useMemo(() => ({ width: innerWidth, gap: 6 }), [innerWidth]);
  return (
    <View style={frameStyle} testID="context-popover">
      <View style={innerStyle}>
        <Text style={titleStyle}>Context window</Text>
        <Text style={titleStyle}>{`${percentage}% used`}</Text>
        <Text style={detailStyle}>
          {`${formatContextTokens(usage.totalTokens)} / ${formatContextTokens(usage.maxTokens)} tokens`}
        </Text>
        <ContextUsageBreakdown
          payload={payload}
          isSupported={isSupported}
          isLoading={isLoading}
          usedTokens={usage.totalTokens}
          tone={tone}
          thresholds={thresholds}
        />
      </View>
    </View>
  );
}

const opusAmber = scaleUsage(opus, 1.5);
const opusRed = scaleUsage(opus, 3);

const CAPTURES: Array<{
  name: string;
  width: number;
  usage: AgentContextUsage;
  payload: AgentContextUsagePayload;
}> = [
  {
    name: "context-meter-neutral-desktop.png",
    width: DESKTOP_WIDTH,
    usage: opus,
    payload: captured(opus),
  },
  {
    name: "context-meter-amber-desktop.png",
    width: DESKTOP_WIDTH,
    usage: opusAmber,
    payload: captured(opusAmber),
  },
  {
    name: "context-meter-red-desktop.png",
    width: DESKTOP_WIDTH,
    usage: opusRed,
    payload: captured(opusRed),
  },
  {
    name: "context-meter-neutral-phone.png",
    width: PHONE_WIDTH,
    usage: opus,
    payload: captured(opus),
  },
  {
    name: "context-meter-amber-phone.png",
    width: PHONE_WIDTH,
    usage: opusAmber,
    payload: captured(opusAmber),
  },
  {
    name: "context-meter-red-phone.png",
    width: PHONE_WIDTH,
    usage: opusRed,
    payload: captured(opusRed),
  },
  {
    name: "context-meter-deferred-phone.png",
    width: PHONE_WIDTH,
    usage: haiku,
    payload: captured(haiku),
  },
];

describe("context meter popover", () => {
  it.each(CAPTURES)("captures $name", async ({ name, width, usage, payload }) => {
    // The runner's iframe is narrower than a phone; give it the width the capture stands for.
    await page.viewport(width, 720);
    const container = mount(<Popover usage={usage} payload={payload} width={width} />, width);
    await page.screenshot({ element: container, path: `../../../../.artifacts/${name}` });
  });

  it("shows no advice while the session is small, and shows the breakdown", () => {
    const container = mount(
      <Popover usage={opus} payload={captured(opus)} width={PHONE_WIDTH} />,
      PHONE_WIDTH,
    );
    expect(container.querySelector('[data-testid="context-usage-advice"]')).toBeNull();
    expect(container.textContent).toContain("Memory files");
    expect(container.textContent).toContain("As of 6m ago");
  });

  it("warns about the memory files that are too big", () => {
    const container = mount(
      <Popover usage={opus} payload={captured(opus)} width={PHONE_WIDTH} />,
      PHONE_WIDTH,
    );
    const warnings = container.querySelector('[data-testid="context-usage-memory-warnings"]');
    expect(warnings?.textContent).toContain("over the 10k guideline");
    expect(warnings?.textContent).toContain("cpu-policing/CLAUDE.md is 8.6k tokens, over 5k");
  });

  it("advises a fresh session once the meter is red", () => {
    const container = mount(
      <Popover usage={opusRed} payload={captured(opusRed)} width={PHONE_WIDTH} />,
      PHONE_WIDTH,
    );
    const advice = container.querySelector('[data-testid="context-usage-advice"]');
    expect(advice?.textContent).toContain("re-reads ~522k tokens every turn");
  });

  it("keeps deferred rows out of the window: no percentage on them", () => {
    const container = mount(
      <Popover usage={haiku} payload={captured(haiku)} width={PHONE_WIDTH} />,
      PHONE_WIDTH,
    );
    const row = container.querySelector('[data-testid="context-usage-row-system_tools_deferred"]');
    expect(row?.textContent).toContain("15.9k");
    expect(row?.textContent).not.toContain("%");
    expect(container.textContent).toContain("Outside the window");
  });

  it("still gives the advice on a daemon without the breakdown, and nothing else", () => {
    const container = mount(
      <Popover usage={opusRed} payload={undefined} isSupported={false} width={PHONE_WIDTH} />,
      PHONE_WIDTH,
    );
    expect(container.querySelector('[data-testid="context-usage-advice"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="context-usage-bar"]')).toBeNull();
  });

  it("renders nothing extra for a small session on a daemon without the breakdown", () => {
    const container = mount(
      <Popover usage={opus} payload={undefined} isSupported={false} width={PHONE_WIDTH} />,
      PHONE_WIDTH,
    );
    expect(container.querySelector('[data-testid="context-usage-advice"]')).toBeNull();
    expect(container.querySelector('[data-testid="context-usage-bar"]')).toBeNull();
  });

  it.each([
    ["pending", "Breakdown appears when this turn ends."],
    ["unsupported", "This provider can't report a context breakdown."],
    ["error", "Couldn't read the context breakdown."],
    ["something-new", "Couldn't read the context breakdown."],
  ])("says what happened for a %s read", (kind, message) => {
    const container = mount(
      <Popover usage={opus} payload={status(kind)} width={PHONE_WIDTH} />,
      PHONE_WIDTH,
    );
    expect(container.textContent).toContain(message);
    expect(container.querySelector('[data-testid="context-usage-bar"]')).toBeNull();
  });

  it("says it is reading while the first read is in flight", () => {
    const container = mount(
      <Popover usage={opus} payload={undefined} isLoading width={PHONE_WIDTH} />,
      PHONE_WIDTH,
    );
    expect(container.textContent).toContain("Reading context…");
  });

  it("fits a 390px phone: nothing overflows the frame", () => {
    for (const usage of [opus, opusAmber, opusRed, haiku]) {
      const container = mount(
        <Popover usage={usage} payload={captured(usage)} width={PHONE_WIDTH} />,
        PHONE_WIDTH,
      );
      const frame = container.querySelector('[data-testid="context-popover"]');
      if (!(frame instanceof HTMLElement)) throw new Error("popover frame missing");
      expect(frame.getBoundingClientRect().width).toBeLessThanOrEqual(PHONE_WIDTH - 16);
      const frameRight = frame.getBoundingClientRect().right;
      const overflowing = Array.from(frame.querySelectorAll("*"))
        .filter((node) => node.getBoundingClientRect().right > frameRight + 1)
        .map((node) => node.textContent);
      expect(overflowing).toEqual([]);
    }
  });
});
