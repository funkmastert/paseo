// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { useRevealedText } from "@/hooks/use-revealed-text";

function Probe({ text, onReveal }: { text: string; onReveal: (revealed: string) => void }) {
  onReveal(useRevealedText(text, "streaming"));
  return null;
}

function renderProbe(active: boolean, text: string, onReveal: (revealed: string) => void) {
  const utils = render(
    <RetainedPanelActivity active={active}>
      <Probe text={text} onReveal={onReveal} />
    </RetainedPanelActivity>,
  );
  const rerenderProbe = (nextActive: boolean, nextText: string) =>
    utils.rerender(
      <RetainedPanelActivity active={nextActive}>
        <Probe text={nextText} onReveal={onReveal} />
      </RetainedPanelActivity>,
    );
  return { ...utils, rerenderProbe };
}

describe("useRevealedText", () => {
  let rafSpy: ReturnType<typeof vi.spyOn>;
  let latest: string;

  beforeEach(() => {
    rafSpy = vi.spyOn(globalThis, "requestAnimationFrame");
    latest = "";
  });

  afterEach(() => {
    rafSpy.mockRestore();
  });

  it("paces growth with a frame clock while the panel is active", async () => {
    const longText = "x".repeat(5000);
    const { rerenderProbe } = renderProbe(true, "x", (revealed) => {
      latest = revealed;
    });
    rerenderProbe(true, longText);

    await waitFor(() => expect(latest).toBe(longText));
    expect(rafSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it("reveals growth immediately with no frame scheduled when the panel is inactive", () => {
    const longText = "x".repeat(5000);
    const { rerenderProbe } = renderProbe(false, "x", (revealed) => {
      latest = revealed;
    });
    rerenderProbe(false, longText);

    // A background agent's row must not keep scheduling a 60fps reveal loop for
    // content nobody can see — main-thread cost must scale with real content
    // arriving, not with the number of agents streaming off-screen.
    expect(latest).toBe(longText);
    expect(rafSpy).not.toHaveBeenCalled();
  });

  it("stops scheduling frames once an active panel goes inactive mid-stream", async () => {
    const longText = "x".repeat(5000);
    const { rerenderProbe } = renderProbe(true, "x", (revealed) => {
      latest = revealed;
    });
    rerenderProbe(true, longText);
    await waitFor(() => expect(latest).toBe(longText));

    const callsWhileActive = rafSpy.mock.calls.length;
    expect(callsWhileActive).toBeGreaterThan(0);

    const evenLongerText = "x".repeat(10000);
    rerenderProbe(false, evenLongerText);

    expect(latest).toBe(evenLongerText);
    expect(rafSpy.mock.calls.length).toBe(callsWhileActive);
  });
});
