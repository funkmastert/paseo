import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JevDecisionRecord } from "@getpaseo/protocol/jev/rpc-schemas";
// Side-effecting: creating the instance is what registers it with react-i18next, so the row
// renders its real copy rather than raw keys.
// eslint-disable-next-line import/no-unassigned-import
import "@/i18n/i18next";
import { JevMarkerChip } from "./jev-marker-chip";
import { buildJevMarkerLines } from "./jev-marker-model";

const PHONE_WIDTH = 390;
const DESKTOP_WIDTH = 1280;

beforeEach(() => {
  vi.stubGlobal("React", React);
});

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
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

const at = (iso: string) => iso;

// `summary` and `tag` below are what the daemon and `jev-decisions-model.ts` actually compute for
// these verdicts and modes (decision-summary.test.ts, jev-decisions-model.ts's `tagFor`), so this
// fixture is what a real row renders rather than a hand-picked string.
const DECISIONS: JevDecisionRecord[] = [
  {
    agentId: "leader-1",
    callId: "c1",
    feature: "stallJudgment",
    question: "Is this stalled?",
    verdict: "blocked_missing_info (0.82)",
    confidence: 0.82,
    action: "nudged with the missing question; a person first",
    applied: true,
    at: at("2026-10-19T12:00:00.000Z"),
    costUsd: 0.0001,
    mode: "live",
    summary: "JEV: stuck, missing information; nudged with the missing question; a person first",
  },
  {
    agentId: "leader-1",
    callId: "c2",
    feature: "spawnHint",
    question: "What class of work is this create?",
    verdict: "standard (0.9)",
    confidence: 0.9,
    action: "would have: standard on claude-sonnet-5",
    applied: false,
    at: at("2026-10-19T12:01:00.000Z"),
    costUsd: 0.00012,
    mode: "shadow",
    wouldBe: "standard on claude-sonnet-5",
    subjectAgentId: "child-1",
    subjectAgentTitle: "rename helper",
    summary: "JEV suggested standard on Sonnet 5",
    detail: "Picked standard tier over mechanical because the task names a rename across files",
  },
];

describe("JevMarkerChip", () => {
  it.each([
    { name: "phone", width: PHONE_WIDTH },
    { name: "desktop", width: DESKTOP_WIDTH },
  ])("shows a one-line row with only the newest summary and a count ($name)", ({ width }) => {
    const lines = buildJevMarkerLines(DECISIONS, null);
    const container = mount(<JevMarkerChip lines={lines} />, width);
    const text = container.textContent ?? "";
    // The newest decision's summary, "JEV"/"JEV:" prefix and raw score stripped.
    expect(text).toContain("suggested standard on Sonnet 5");
    expect(text).not.toContain("JEV suggested");
    expect(text).not.toMatch(/\(0\.\d+\)/);
    // The count of the rest, not the per-decision detail.
    expect(text).toContain("+1");
    expect(text).not.toContain("Checking whether this agent is still making progress");
    expect(text).not.toContain("Watching only, nothing was changed");
    expect(text).not.toContain("rename helper");
  });

  it("omits the count for a single decision", () => {
    const lines = buildJevMarkerLines([DECISIONS[0]], null);
    const container = mount(<JevMarkerChip lines={lines} />, DESKTOP_WIDTH);
    expect(container.textContent).not.toContain("+0");
    expect(container.textContent).not.toMatch(/\+\d/);
  });

  it("keeps the row the same height for a group of 40 decisions as for 5", () => {
    const decisions = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        ...DECISIONS[0],
        callId: `c${index}`,
        at: new Date(Date.parse("2026-10-19T12:00:00.000Z") + index * 60_000).toISOString(),
      }));
    const five = mount(
      <JevMarkerChip lines={buildJevMarkerLines(decisions(5), null)} />,
      PHONE_WIDTH,
    );
    const forty = mount(
      <JevMarkerChip lines={buildJevMarkerLines(decisions(40), null)} />,
      PHONE_WIDTH,
    );
    expect(forty.textContent).toContain("+39");
    expect(forty.getBoundingClientRect().height).toBe(five.getBoundingClientRect().height);
  });

  it("opens the popover with the purpose, detail, subject and watching-only text on hover", async () => {
    const lines = buildJevMarkerLines(DECISIONS, null);
    const container = mount(<JevMarkerChip lines={lines} />, DESKTOP_WIDTH);
    const trigger = container.querySelector('[role="button"]') as HTMLElement;
    act(() => {
      trigger.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    });
    await vi.waitFor(() => {
      const body = document.body.textContent ?? "";
      expect(body).toContain("Checking whether this agent is still making progress");
      expect(body).toContain("Sizing up how much help a new agent needs");
      expect(body).toContain("Picked standard tier over mechanical");
      expect(body).toContain("rename helper");
      expect(body).toContain("Watching only, nothing was changed");
      expect(body).toContain("standard (0.9)");
      expect(body).toContain("$0.0001");
    });
  });

  it("keeps the row plain and renders the verdict once in the popover for a record without a summary (old daemon)", async () => {
    const old: JevDecisionRecord = {
      ...DECISIONS[0],
      callId: "c-old",
      summary: undefined,
      detail: undefined,
    };
    const lines = buildJevMarkerLines([old], null);
    const container = mount(<JevMarkerChip lines={lines} />, DESKTOP_WIDTH);
    // The row itself names the feature and the plain verdict: no raw score, no snake_case.
    const row = container.textContent ?? "";
    expect(row).toContain("blocked missing info");
    expect(row).not.toContain("blocked_missing_info");
    expect(row).not.toMatch(/\(0\.\d+\)/);
    expect(row).not.toContain(old.action);
    const trigger = container.querySelector('[role="button"]') as HTMLElement;
    act(() => {
      trigger.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    });
    await vi.waitFor(() => {
      const popover = document.getElementById("overlay-root")?.textContent ?? "";
      expect(popover).toContain(old.action);
      expect(popover.match(/blocked_missing_info \(0\.82\)/g)).toHaveLength(1);
    });
  });

  it.each([
    { name: "phone", width: PHONE_WIDTH },
    { name: "desktop", width: DESKTOP_WIDTH },
  ])("captures the row on $name", async ({ name, width }) => {
    await page.viewport(width, 300);
    const lines = buildJevMarkerLines(DECISIONS, null);
    const container = mount(<JevMarkerChip lines={lines} />, width);
    await page.screenshot({
      element: container,
      path: `../../../../.artifacts/jev-marker-chip-${name}.png`,
    });
  });
});
