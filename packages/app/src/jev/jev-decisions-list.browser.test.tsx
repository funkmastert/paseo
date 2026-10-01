import React, { act, useMemo, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Text, View } from "react-native";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JevDecisionRecord, JevStatus } from "@getpaseo/protocol/jev/rpc-schemas";
// Side-effecting: creating the instance is what registers it with react-i18next, so the section
// renders its real copy rather than raw keys.
// eslint-disable-next-line import/no-unassigned-import
import "@/i18n/i18next";
import { JevDecisionsList } from "./jev-decisions-list";
import { buildJevDecisionsView } from "./jev-decisions-model";

const NOW_MS = Date.parse("2026-09-29T18:00:00.000Z");
const PHONE_WIDTH = 390;
const DESKTOP_WIDTH = 720;
// The meter's tooltip width: 320, or the window less a margin on a narrower screen.
const TOOLTIP_MAX_WIDTH = 320;
const TOOLTIP_SCREEN_MARGIN = 32;

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

const minutesAgo = (minutes: number) => new Date(NOW_MS - minutes * 60_000).toISOString();

// A leader's decisions as the store returns them, newest first: one from each feature that
// records for an agent, shadow and live.
const DECISIONS: JevDecisionRecord[] = [
  {
    agentId: "leader-1",
    callId: "c1",
    feature: "awayReply",
    question: "Does this wait need Tyler, and what should be said?",
    verdict: "blocked_on_person 0.08, reply_kind confirm 0.86",
    confidence: 0.86,
    action: "would reply (routine confirmation); dry run, nothing sent",
    applied: false,
    at: minutesAgo(3),
    costUsd: 0.00021,
  },
  {
    agentId: "leader-1",
    callId: "c2",
    feature: "askJev",
    question: "Is this branch ready to merge?",
    verdict: "yes 0.71",
    confidence: 0.71,
    action: "asked by a person in the app",
    applied: true,
    at: minutesAgo(18),
    costUsd: 0.00034,
  },
  {
    agentId: "leader-1",
    callId: "c3",
    feature: "remediationTriage",
    question: "Should a remediation agent handle this?",
    verdict: "person (0.91)",
    confidence: 0.91,
    action: "would have: no remediation agent; sent to a person (not applied; agent started)",
    applied: false,
    at: minutesAgo(47),
    costUsd: 0.00019,
  },
  {
    agentId: "leader-1",
    callId: "c4",
    feature: "spawnHint",
    question: "What class of work is this create?",
    verdict: "task_class mechanical 0.91, reasoning 0.6",
    confidence: 0.91,
    action: "classifier input at create",
    applied: false,
    at: minutesAgo(62),
    costUsd: 0.00012,
  },
];

const STATUS = {
  provider: "openrouter",
  features: {
    spawnHint: { enabled: true, shadow: true },
    remediationTriage: { enabled: true, shadow: true },
    awayReply: { enabled: true, shadow: true },
    askJev: { enabled: true, shadow: false },
  },
} as unknown as JevStatus;

const frameStyle = {
  paddingVertical: 4,
  paddingHorizontal: 8,
  borderRadius: 12,
  borderWidth: 1,
  borderColor: "#a1a1aa",
  backgroundColor: "#ffffff",
} as const;
const titleStyle = { fontSize: 16, color: "#111111" } as const;

/** The popover's frame and header, with the JEV section where the meter mounts it. */
function Popover({
  decisions,
  status,
  width,
}: {
  decisions: JevDecisionRecord[];
  status: JevStatus | null;
  width: number;
}) {
  const innerWidth = Math.min(TOOLTIP_MAX_WIDTH, width - TOOLTIP_SCREEN_MARGIN);
  const innerStyle = useMemo(() => ({ width: innerWidth, gap: 6 }), [innerWidth]);
  const view = useMemo(() => buildJevDecisionsView(decisions, status), [decisions, status]);
  return (
    <View style={frameStyle} testID="context-popover">
      <View style={innerStyle}>
        <Text style={titleStyle}>Context window</Text>
        <Text style={titleStyle}>38% used</Text>
        <JevDecisionsList view={view} now={new Date(NOW_MS)} />
      </View>
    </View>
  );
}

describe("JEV decisions in the context popover", () => {
  it("lists each decision with its feature, question, answer, action and cost", () => {
    const container = mount(
      <Popover decisions={DECISIONS} status={STATUS} width={PHONE_WIDTH} />,
      PHONE_WIDTH,
    );
    const rows = Array.from(container.querySelectorAll('[data-testid="jev-decision"]'));
    expect(rows).toHaveLength(4);
    expect(rows[0].textContent).toContain("Away reply");
    expect(rows[0].textContent).toContain("Dry run");
    expect(rows[0].textContent).toContain("3m ago · $0.0002");
    expect(rows[0].textContent).toContain(
      "blocked_on_person 0.08, reply_kind confirm 0.86 → would reply (routine confirmation); dry run, nothing sent",
    );
    // Ask JEV was answered for a person: applied, so no tag.
    expect(rows[1].textContent).not.toMatch(/Shadow|Dry run|Not applied/);
    expect(rows[2].textContent).toContain("Shadow");
    expect(rows[2].textContent).toContain("Should a remediation agent handle this?");
  });

  it("is absent for an agent with no decisions, and on a host that predates JEV", () => {
    // An older host is never asked (use-agent-jev-decisions.test.tsx), so it reaches here as [].
    const container = mount(
      <Popover decisions={[]} status={null} width={PHONE_WIDTH} />,
      PHONE_WIDTH,
    );
    expect(container.querySelector('[data-testid="jev-decisions"]')).toBeNull();
    expect(container.textContent).not.toContain("JEV decisions");
  });

  it("keeps every decision inside the tooltip, truncating nothing", () => {
    const container = mount(
      <Popover decisions={DECISIONS} status={STATUS} width={PHONE_WIDTH} />,
      PHONE_WIDTH,
    );
    // The section's divider bleeds to the tooltip's edge on purpose, as the breakdown's does, so
    // only the list is measured.
    const list = container.querySelectorAll(
      '[data-testid="jev-decisions"], [data-testid="jev-decisions"] *',
    );
    const overflowing = Array.from(list).filter(
      (node) => node.scrollWidth > node.clientWidth + 1 && node.clientWidth > 0,
    );
    expect(overflowing.map((node) => node.getAttribute("data-testid") ?? node.tagName)).toEqual([]);
  });

  it.each([
    { name: "phone", width: PHONE_WIDTH },
    { name: "desktop", width: DESKTOP_WIDTH },
  ])("captures the section on $name", async ({ name, width }) => {
    await page.viewport(width, 900);
    const container = mount(<Popover decisions={DECISIONS} status={STATUS} width={width} />, width);
    await page.screenshot({
      element: container,
      path: `../../../../.artifacts/jev-decisions-popover-${name}.png`,
    });
  });
});
