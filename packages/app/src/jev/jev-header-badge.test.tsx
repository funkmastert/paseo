import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Side-effecting: creating the instance is what registers it with react-i18next, so the popover
// renders its real copy rather than raw keys.
// eslint-disable-next-line import/no-unassigned-import
import "@/i18n/i18next";
import { JevHeaderBadgeView } from "./jev-header-badge";
import { buildJevDecisionsView } from "./jev-decisions-model";
import type { JevDecisionRecord } from "@getpaseo/protocol/jev/rpc-schemas";

// Mocked the way tooltip.test.tsx mocks it, plus `withUnistyles` for this component's icon, to
// render the real Tooltip/TooltipTrigger/TooltipContent (not a browser mount) and exercise the
// compact "open on tap" branch deterministically — jev-header-badge.browser.test.tsx covers
// rendering at real widths instead, where that branch doesn't reliably follow `page.viewport()`.
vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
}));

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => true,
}));

vi.mock("@gorhom/portal", () => ({
  Portal: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@gorhom/bottom-sheet", () => ({
  useBottomSheetModalInternal: () => null,
}));

vi.mock("react-native-reanimated", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...actual, default: { ...(actual as { default?: object }).default, View: "div" } };
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: (styles: unknown) => (typeof styles === "function" ? {} : styles) },
  withUnistyles: (Component: unknown) => Component,
}));

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);
  vi.stubGlobal("MouseEvent", dom.window.MouseEvent);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

const DECISION: JevDecisionRecord = {
  agentId: "leader-1",
  callId: "c1",
  feature: "stallJudgment",
  question: "Is this stalled?",
  verdict: "yes (0.8)",
  confidence: 0.8,
  action: "nudged with a person-first handoff",
  applied: true,
  at: "2026-10-18T12:00:00.000Z",
  costUsd: 0.0001,
  summary: "JEV judged the stall needs you",
  subjectAgentId: "child-1",
  subjectAgentTitle: "rename helper",
};

function renderBadge(onOpenAllActivity?: () => void): void {
  const view = buildJevDecisionsView([DECISION], null);
  act(() => {
    root?.render(
      <JevHeaderBadgeView count={1} view={view} onOpenAllActivity={onOpenAllActivity} />,
    );
  });
}

// The popover's content renders through a portal appended to document.body (getOverlayRoot),
// not inside `container`, so every lookup here goes through the body.
function click(selector: string): void {
  const el = document.body.querySelector(selector);
  expect(el).not.toBeNull();
  act(() => {
    el?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

describe("JevHeaderBadgeView: tap to open on a compact layout", () => {
  it("opens the decisions popover naming the child on tap", () => {
    renderBadge();
    click('[data-testid="jev-header-badge-trigger"]');
    // jev-decisions-list.tsx: the child's name, the question and the verdict.
    expect(document.body.textContent).toContain("rename helper");
    expect(document.body.textContent).toContain("Is this stalled?");
    expect(document.body.textContent).toContain("yes (0.8)");
  });

  it("calls onOpenAllActivity from the popover's link", () => {
    const onOpenAllActivity = vi.fn();
    renderBadge(onOpenAllActivity);
    click('[data-testid="jev-header-badge-trigger"]');
    click('[data-testid="jev-all-activity-link"]');
    expect(onOpenAllActivity).toHaveBeenCalledTimes(1);
  });
});
