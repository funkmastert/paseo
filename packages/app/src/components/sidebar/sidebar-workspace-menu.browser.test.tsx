import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LayoutAnimationConfig } from "react-native-reanimated";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { ToastProvider } from "@/contexts/toast-context";
// Side-effecting: creating the instance is what registers it with react-i18next, so the menu
// renders real copy rather than raw keys.
// eslint-disable-next-line import/no-unassigned-import
import "@/i18n/i18next";

// The menu builds its leading icons at module scope, so React has to be global before it loads.
vi.stubGlobal("React", React);
const { SidebarWorkspaceMenu, SidebarWorkspaceMenuItems } =
  await import("./sidebar-workspace-menu");

let mounted: { root: Root; container: HTMLDivElement } | null = null;

// SidebarWorkspaceMenuItems unconditionally renders OpenInFileManagerMenuItem, which reads
// react-query via useDesktopOpenTargets even when its query is disabled (not Electron, no path).
// skipEntering/skipExiting: a screenshot forces a paint mid-animation, and Reanimated's web
// layout-animation handler then throws on the torn-down node (`_updatePropsJS` in
// componentUtils.ts) — same issue jev-header-badge.browser.test.tsx works around. The popover's
// fade isn't what these tests assert on.
function mount(node: React.ReactNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient();
  act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <LayoutAnimationConfig skipEntering skipExiting>
            {node}
          </LayoutAnimationConfig>
        </ToastProvider>
      </QueryClientProvider>,
    ),
  );
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

const COPY_AGENT_ID_TESTID = "sidebar-workspace-menu-copy-agent-id-w1";

function noop() {}

describe("SidebarWorkspaceMenuItems — Copy ID", () => {
  it('renders a "Copy ID" item when onCopyAgentId is provided', () => {
    const container = mount(
      <DropdownMenu open>
        <SidebarWorkspaceMenuItems surface="dropdown" workspaceKey="w1" onCopyAgentId={noop} />
      </DropdownMenu>,
    );
    const item = container.querySelector(`[data-testid="${COPY_AGENT_ID_TESTID}"]`);
    expect(item).not.toBeNull();
    expect(container.textContent).toContain("Copy ID");
  });

  it('does not render a "Copy ID" item when onCopyAgentId is undefined', () => {
    const container = mount(
      <DropdownMenu open>
        <SidebarWorkspaceMenuItems surface="dropdown" workspaceKey="w1" />
      </DropdownMenu>,
    );
    const item = container.querySelector(`[data-testid="${COPY_AGENT_ID_TESTID}"]`);
    expect(item).toBeNull();
    expect(container.textContent).not.toContain("Copy ID");
  });

  it("calls onCopyAgentId when the item is selected", async () => {
    const onCopyAgentId = vi.fn();
    const container = mount(
      <DropdownMenu open>
        <SidebarWorkspaceMenuItems
          surface="dropdown"
          workspaceKey="w1"
          onCopyAgentId={onCopyAgentId}
        />
      </DropdownMenu>,
    );
    const item = container.querySelector(`[data-testid="${COPY_AGENT_ID_TESTID}"]`) as HTMLElement;
    expect(item).not.toBeNull();
    await act(async () => {
      item.click();
    });
    expect(onCopyAgentId).toHaveBeenCalledTimes(1);
  });

  it("captures the open menu with the Copy ID item visible", async () => {
    document.body.style.margin = "0";
    document.body.style.width = "420px";
    // Mounted already open (not opened via a trigger click): a dynamic closed->open transition
    // desyncs Reanimated's web entering animation from this headless browser's rAF callbacks and
    // crashes on an unrelated internal teardown; mounting pre-open avoids that transition.
    mount(<SidebarWorkspaceMenu workspaceKey="w1" onArchive={noop} onCopyAgentId={noop} open />);
    // The popover portals outside the mount container (docs/menus.md), so the screenshot must
    // cover the full page.
    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("Copy ID");
    });
    const copyIdItem = document.querySelector(`[data-testid="${COPY_AGENT_ID_TESTID}"]`);
    expect(copyIdItem).not.toBeNull();
    const rect = (copyIdItem as HTMLElement).getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
    await page.screenshot({
      path: "../../../../../.artifacts/sidebar-workspace-menu-copy-id.png",
    });
  });
});
