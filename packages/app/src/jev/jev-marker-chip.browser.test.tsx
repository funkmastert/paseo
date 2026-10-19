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
  },
];

describe("JevMarkerChip", () => {
  it.each([
    { name: "phone", width: PHONE_WIDTH },
    { name: "desktop", width: DESKTOP_WIDTH },
  ])("shows what JEV checked, decided, and whether it acted without a tap ($name)", ({ width }) => {
    const lines = buildJevMarkerLines(DECISIONS, null);
    const container = mount(<JevMarkerChip lines={lines} />, width);
    const text = container.textContent ?? "";
    // The purpose line, per feature, with no tap.
    expect(text).toContain("Checking whether this agent is still making progress");
    expect(text).toContain("Sizing up how much help a new agent needs");
    // What it decided and what happened, in plain words, no snake_case or raw scores.
    expect(text).not.toMatch(/blocked_missing_info|\(0\.\d+\)/);
    // Who the second decision was about.
    expect(text).toContain("rename helper");
    // Shadow mode reads as a sentence, not a bare "Shadow" badge.
    expect(text).toContain("Watching only, nothing was changed");
  });

  it("collapses more than three decisions into the newest plus a count", () => {
    const many = Array.from({ length: 5 }, (_, index) => ({
      ...DECISIONS[0],
      callId: `c${index}`,
      at: at(`2026-10-19T12:0${index}:00.000Z`),
    }));
    const lines = buildJevMarkerLines(many, null);
    const container = mount(<JevMarkerChip lines={lines} />, DESKTOP_WIDTH);
    expect(container.textContent).toContain("+2 more");
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
    expect(forty.textContent).toContain("+37 more");
    expect(forty.getBoundingClientRect().height).toBe(five.getBoundingClientRect().height);
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
