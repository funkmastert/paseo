import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JevQuestion } from "@getpaseo/protocol/jev/rpc-schemas";
import { mapAskJevPayload, type AskJevPayload } from "./ask-jev-result";
import { ASK_JEV_CLASSIFIES_NOTE, AskJevResultCard } from "./ask-jev-result-view";

/** The Ask JEV answer card in a real browser: headline, bars, meta line and refusals. */

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

beforeEach(() => {
  vi.stubGlobal("React", React);
});

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function mount(node: ReactNode): HTMLDivElement {
  const container = document.createElement("div");
  container.style.width = "390px";
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

function payload(overrides: Partial<AskJevPayload>): AskJevPayload {
  return {
    requestId: "req-1",
    callId: "call-1",
    outcome: "answered",
    reason: null,
    answer: null,
    model: "jev-fake",
    elapsedMs: 4,
    cost: { usd: 0, source: "fake" },
    redactions: 0,
    ...overrides,
  };
}

function text(container: HTMLElement, testId: string): string {
  return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
}

describe("AskJevResultCard", () => {
  it("draws a yes/no answer with both bars, the meta line and the note", () => {
    const question: JevQuestion = { type: "noul", instructions: "Is the build broken?" };
    const container = mount(
      <AskJevResultCard
        result={mapAskJevPayload(payload({ answer: { type: "noul", noul: 0.82 } }), question)}
      />,
    );

    expect(text(container, "ask-jev-headline")).toBe("Yes");
    expect(text(container, "ask-jev-bar-yes")).toContain("82%");
    expect(text(container, "ask-jev-bar-no")).toContain("18%");
    expect(text(container, "ask-jev-meta")).toBe("$0 (fake backend) · 4 ms · jev-fake");
    expect(container.textContent).toContain(ASK_JEV_CLASSIFIES_NOTE);
  });

  it("draws a pick-one answer with a bar per option", () => {
    const question: JevQuestion = {
      type: "choice",
      instructions: "Which area?",
      criteria: { parser: null, network: null, storage: null },
    };
    const container = mount(
      <AskJevResultCard
        result={mapAskJevPayload(
          payload({
            answer: {
              type: "choice",
              choice: "storage",
              probabilities: { parser: 0.2, network: 0.1, storage: 0.7 },
              confidence: 0.7,
            },
          }),
          question,
        )}
      />,
    );

    expect(text(container, "ask-jev-headline")).toBe("storage");
    expect(container.querySelectorAll('[data-testid^="ask-jev-bar-"]')).toHaveLength(3);
    expect(text(container, "ask-jev-bar-storage")).toContain("70%");
  });

  it("draws a score with its position on the scale", () => {
    const question: JevQuestion = {
      type: "score",
      instructions: "How risky?",
      criteria: ["Low", "Medium", "High"],
    };
    const container = mount(
      <AskJevResultCard
        result={mapAskJevPayload(
          payload({
            answer: {
              type: "score",
              score: 1.4,
              legend: { "0": "Low", "1": "Medium", "2": "High" },
              probabilities: { "0": 0.1, "1": 0.4, "2": 0.5 },
              confidence: 0.5,
            },
          }),
          question,
        )}
      />,
    );

    expect(text(container, "ask-jev-headline")).toBe("Medium");
    expect(text(container, "ask-jev-position")).toContain("Low");
    expect(text(container, "ask-jev-position")).toContain("High");
  });

  it("shows a refusal as an alert with no meta line when nothing was sent", () => {
    const container = mount(
      <AskJevResultCard
        result={mapAskJevPayload(
          payload({ outcome: "unavailable", reason: "excluded", cost: null, model: null }),
          { type: "noul", instructions: "Anything?" },
        )}
      />,
    );

    expect(text(container, "ask-jev-notice")).toContain("Blocked by the Wonderly exclusion");
    expect(container.querySelector('[data-testid="ask-jev-meta"]')).toBeNull();
  });
});
