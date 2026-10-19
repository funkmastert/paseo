import React, { act, useMemo, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { View } from "react-native";
import { LayoutAnimationConfig } from "react-native-reanimated";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JevDecisionRecord, JevStatus } from "@getpaseo/protocol/jev/rpc-schemas";
// Side-effecting: creating the instance is what registers it with react-i18next, so the badge
// renders its real copy rather than raw keys.
// eslint-disable-next-line import/no-unassigned-import
import "@/i18n/i18next";
import { JevHeaderBadgeView } from "./jev-header-badge";
import { buildJevDecisionsView } from "./jev-decisions-model";

const NOW_MS = Date.parse("2026-09-29T18:00:00.000Z");
// Unistyles breakpoints (styles/unistyles.ts): xs=0, sm=576, md=720. Below sm is compact, which
// is what makes the tooltip trigger open on tap rather than hover (components/ui/tooltip.tsx).
const PHONE_WIDTH = 390;
const DESKTOP_WIDTH = 720;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW_MS);
});

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  vi.useRealTimers();
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function mount(node: ReactNode, width: number): HTMLDivElement {
  const container = document.createElement("div");
  container.style.width = `${width}px`;
  container.style.padding = "16px";
  document.body.style.margin = "0";
  document.body.style.width = `${width}px`;
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

const minutesAgo = (minutes: number) => new Date(NOW_MS - minutes * 60_000).toISOString();

// Mixes a decision about the leader itself with one named for a child, as the daemon returns
// when `jev.decisions.list` is asked with `includeChildren`.
const DECISIONS: JevDecisionRecord[] = [
  {
    agentId: "leader-1",
    callId: "c1",
    feature: "stallJudgment",
    question: "Is this stalled?",
    verdict: "yes (0.8)",
    confidence: 0.8,
    action: "nudged with a person-first handoff",
    applied: true,
    at: minutesAgo(3),
    costUsd: 0.0001,
    summary: "JEV judged the stall needs you",
  },
  {
    agentId: "child-1",
    callId: "c2",
    feature: "spawnHint",
    question: "What class of work is this create?",
    verdict: "mechanical (0.91)",
    confidence: 0.91,
    action: "classifier input at create",
    applied: true,
    at: minutesAgo(18),
    costUsd: 0.00012,
    summary: "JEV set this create's task class: mechanical on claude-haiku-4-5",
    subjectAgentId: "child-1",
    subjectAgentTitle: "rename helper",
  },
];

const STATUS = {
  provider: "openrouter",
  features: {
    stallJudgment: { enabled: true, shadow: false },
    spawnHint: { enabled: true, shadow: false },
  },
} as unknown as JevStatus;

// Mirrors how JevHeaderBadge itself gates on count: JevHeaderBadgeView has no data source and
// does not hide itself, so the "hidden at zero" behavior is the caller's job to reproduce here.
function Harness({
  decisions,
  onOpenAllActivity,
}: {
  decisions: JevDecisionRecord[];
  onOpenAllActivity?: () => void;
}) {
  const view = useMemo(() => buildJevDecisionsView(decisions, STATUS), [decisions]);
  return (
    <View style={styles.harness}>
      {decisions.length === 0 ? null : (
        // This file drives `vi.useFakeTimers` for deterministic "time ago" text, which desyncs
        // Reanimated's web entering animation from real rAF callbacks and otherwise crashes on
        // unmount (`_updatePropsJS` reading a torn-down registry entry). The badge's mount-fade
        // isn't what these tests assert on, so skip it here rather than fight the interaction.
        <LayoutAnimationConfig skipEntering skipExiting>
          <JevHeaderBadgeView
            count={decisions.length}
            view={view}
            onOpenAllActivity={onOpenAllActivity}
          />
        </LayoutAnimationConfig>
      )}
    </View>
  );
}

const styles = { harness: { backgroundColor: "#ececef" } } as const;

describe("JevHeaderBadgeView", () => {
  it.each([
    { name: "phone", width: PHONE_WIDTH },
    { name: "desktop", width: DESKTOP_WIDTH },
  ])(
    "renders the count badge at $name width, hidden when there are no decisions",
    async ({ width }) => {
      await page.viewport(width, 500);
      const container = mount(<Harness decisions={DECISIONS} />, width);
      const badge = container.querySelector('[data-testid="jev-header-badge"]');
      expect(badge).not.toBeNull();
      expect(badge?.textContent).toContain("2");

      const empty = mount(<Harness decisions={[]} />, width);
      expect(empty.querySelector('[data-testid="jev-header-badge"]')).toBeNull();
    },
  );

  // Tapping to open (vs. hovering) depends on `useIsCompactFormFactor()`, which reads a cached
  // breakpoint that doesn't follow `page.viewport()` in this harness — see
  // jev-header-badge.test.tsx for the press-opens-the-popover behavior, mocked the way
  // tooltip.test.tsx mocks it.

  it.each([
    { name: "phone", width: PHONE_WIDTH },
    { name: "desktop", width: DESKTOP_WIDTH },
  ])("captures the header badge on $name", async ({ name, width }) => {
    await page.viewport(width, 500);
    const container = mount(<Harness decisions={DECISIONS} />, width);
    await page.screenshot({
      element: container,
      path: `../../../../.artifacts/jev-header-badge-${name}.png`,
    });
  });
});
