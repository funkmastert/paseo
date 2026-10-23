import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/contexts/toast-context";
import { PaneActiveAgentIdChip } from "./workspace-pane-active-agent-chip";
import type { PaneTabActivity } from "./workspace-pane-active-agent";
// Side-effecting: creating the instance is what registers it with react-i18next, so the chip
// renders real copy rather than raw keys.
// eslint-disable-next-line import/no-unassigned-import
import "@/i18n/i18next";

const AGENT_ID = "a73ccfd3f9c04e5f8b1234567890abcdef";
const SHORT_ID = "a73ccfd";

let mounted: { root: Root; container: HTMLDivElement } | null = null;

function mount(node: React.ReactNode): HTMLDivElement {
  const container = document.createElement("div");
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

// This component only renders on the desktop/non-split-fallback tab row — the mobile tab
// switcher uses a separate trigger (ResolvedMobileActiveTabTrigger in workspace-screen.tsx) that
// already shows AgentIdChip. Mounting PaneActiveAgentIdChip directly exercises exactly the
// desktop-only code path, independent of useIsCompactFormFactor.
describe("PaneActiveAgentIdChip (desktop pane toolbar)", () => {
  it("shows the active agent tab's id chip", () => {
    const tabs: PaneTabActivity[] = [
      {
        tab: { key: "files", tabId: "files", kind: "files", target: { kind: "files" } },
        isActive: false,
      },
      {
        tab: {
          key: "agent",
          tabId: "agent",
          kind: "agent",
          target: { kind: "agent", agentId: AGENT_ID },
        },
        isActive: true,
      },
    ];
    const container = mount(<PaneActiveAgentIdChip tabs={tabs} testID="pane-agent-id" />);
    const chip = container.querySelector('[data-testid="pane-agent-id"]');
    expect(chip?.textContent).toBe(SHORT_ID);
  });

  it("renders nothing when the active tab is not an agent", () => {
    const tabs: PaneTabActivity[] = [
      {
        tab: {
          key: "agent",
          tabId: "agent",
          kind: "agent",
          target: { kind: "agent", agentId: AGENT_ID },
        },
        isActive: false,
      },
      {
        tab: { key: "files", tabId: "files", kind: "files", target: { kind: "files" } },
        isActive: true,
      },
    ];
    const container = mount(<PaneActiveAgentIdChip tabs={tabs} testID="pane-agent-id" />);
    expect(container.querySelector('[data-testid="pane-agent-id"]')).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("captures the pane toolbar chip for a focused agent tab", async () => {
    const tabs: PaneTabActivity[] = [
      {
        tab: {
          key: "agent",
          tabId: "agent",
          kind: "agent",
          target: { kind: "agent", agentId: AGENT_ID },
        },
        isActive: true,
      },
    ];
    const container = mount(<PaneActiveAgentIdChip tabs={tabs} testID="pane-agent-id" />);
    await page.screenshot({
      element: container,
      path: "../../../../.artifacts/workspace-desktop-pane-agent-id-chip.png",
    });
  });
});
