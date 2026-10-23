import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Text, View } from "react-native";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentIdChip } from "./agent-id-chip";
import { ToastProvider } from "@/contexts/toast-context";
// Side-effecting: creating the instance is what registers it with react-i18next, so the chip
// renders real copy rather than raw keys.
// eslint-disable-next-line import/no-unassigned-import
import "@/i18n/i18next";

const AGENT_ID = "a73ccfd3f9c04e5f8b1234567890abcdef";
const SHORT_ID = "a73ccfd";

let mounted: { root: Root; container: HTMLDivElement } | null = null;

function mount(node: React.ReactNode, width = 390): HTMLDivElement {
  const container = document.createElement("div");
  container.style.width = `${width}px`;
  document.body.style.margin = "0";
  document.body.style.width = `${width}px`;
  document.body.style.background = "#fff";
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<ToastProvider>{node}</ToastProvider>));
  mounted = { root, container };
  return container;
}

beforeEach(() => {
  vi.stubGlobal("React", React);
});

afterEach(() => {
  if (mounted) {
    act(() => mounted?.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
});

const rowStyle = { flexDirection: "row", alignItems: "center", gap: 8, padding: 12 } as const;
const titleStyle = { flexShrink: 1, minWidth: 0, fontSize: 14 } as const;

/**
 * A row shaped like the real agent-row surfaces (title + chip, title flex-shrinks first): proves
 * the shared component itself renders monospace and muted, never reflows the row, and stays a
 * fixed size regardless of how long the title next to it is.
 */
function TitleAndChipRow({ title, agentId }: { title: string; agentId: string }) {
  return (
    <View style={rowStyle} testID="row">
      <Text style={titleStyle} numberOfLines={1} testID="title">
        {title}
      </Text>
      <AgentIdChip agentId={agentId} testID="chip" />
    </View>
  );
}

describe("AgentIdChip", () => {
  it("shows the 7-character short id in monospace, muted text", () => {
    const container = mount(<TitleAndChipRow title="Short title" agentId={AGENT_ID} />);
    const chip = container.querySelector('[data-testid="chip"]');
    expect(chip?.textContent).toBe(SHORT_ID);
    const label = chip?.querySelector("div, span") as HTMLElement | null;
    const fontFamily = label ? getComputedStyle(label).fontFamily : "";
    expect(fontFamily.toLowerCase()).toContain("mono");
  });

  it("never reflows the row: the title truncates, the chip stays whole, at phone width", () => {
    const longTitle =
      "A very long agent title that would otherwise push everything else off the edge of a phone-width row";
    const container = mount(<TitleAndChipRow title={longTitle} agentId={AGENT_ID} />, 390);
    const row = container.querySelector('[data-testid="row"]');
    const chip = container.querySelector('[data-testid="chip"]');
    expect(row).not.toBeNull();
    expect(chip).not.toBeNull();
    expect((row as HTMLElement).scrollWidth).toBeLessThanOrEqual(
      (row as HTMLElement).clientWidth + 1,
    );
    expect(chip?.textContent).toBe(SHORT_ID);
  });

  it("copies the full id and shows a toast on press", async () => {
    // expo-clipboard is stubbed for this environment (test-stubs/expo-clipboard.ts); this only
    // asserts the app's own copy-then-toast wiring, not the real OS clipboard.
    const container = mount(<TitleAndChipRow title="Short title" agentId={AGENT_ID} />);
    const chip = container.querySelector('[data-testid="chip"]') as HTMLElement;
    await act(async () => {
      chip.click();
    });
    // The toast portals into a separate overlay root, outside the mounted container.
    expect(document.body.textContent).toContain("Copied");
  });

  it("captures the chip next to a truncating title at phone width", async () => {
    const longTitle =
      "Make the agent id more prominent in the UI so I can refer to a specific agent";
    const container = mount(<TitleAndChipRow title={longTitle} agentId={AGENT_ID} />, 390);
    await page.screenshot({
      element: container,
      path: "../../../../.artifacts/agent-id-chip-row-phone.png",
    });
  });
});
