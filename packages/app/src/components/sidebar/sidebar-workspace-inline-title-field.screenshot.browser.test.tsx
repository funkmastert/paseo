import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { View, Text } from "react-native";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarWorkspaceInlineTitleField } from "./sidebar-workspace-inline-title-field";
import { ToastProvider } from "@/contexts/toast-context";
// Side-effecting: creating the instance is what registers it with react-i18next, so the field
// renders real copy (its placeholder) rather than a raw key.
// eslint-disable-next-line import/no-unassigned-import
import "@/i18n/i18next";

const rename = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("@/hooks/use-workspace-rename", () => ({
  useWorkspaceRename: () => ({ rename, isPending: false, error: null }),
}));

const WORKSPACE = {
  serverId: "server-1",
  workspaceId: "workspace-1",
  name: "Add workspace title tracking",
  title: "Add workspace title tracking",
};

const rowStyle = {
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: 8,
  padding: 8,
  borderRadius: 8,
  backgroundColor: "#1c1f26",
};
const dotStyle = { width: 8, height: 8, borderRadius: 4, backgroundColor: "#5b8dee" };
const titleStyle = { color: "#e8eaed", fontSize: 15, flex: 1, minWidth: 0 };

/**
 * A row shaped like the real sidebar row (a status dot, then the name), the same simplification
 * `agent-id-chip.browser.test.tsx`'s `TitleAndChipRow` uses rather than mounting the full
 * `SidebarWorkspaceRowContent` and its `SidebarWorkspaceEntry` fixture.
 */
function SidebarRowShape({ editing, onDone }: { editing: boolean; onDone: () => void }) {
  return (
    <ToastProvider>
      <View style={rowStyle} testID="row">
        <View style={dotStyle} />
        {editing ? (
          <SidebarWorkspaceInlineTitleField
            workspace={WORKSPACE}
            onDone={onDone}
            testID="sidebar-inline-title"
          />
        ) : (
          <Text style={titleStyle} numberOfLines={1}>
            {WORKSPACE.title}
          </Text>
        )}
      </View>
    </ToastProvider>
  );
}

let mounted: { root: Root; container: HTMLDivElement } | null = null;

function noop(): void {}

beforeEach(() => {
  vi.stubGlobal("React", React);
});

function mount(width: number): HTMLDivElement {
  const container = document.createElement("div");
  container.style.width = `${width}px`;
  container.style.padding = "12px";
  container.style.background = "#111318";
  document.body.style.margin = "0";
  document.body.style.width = `${width}px`;
  document.body.style.background = "#111318";
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<SidebarRowShape editing onDone={noop} />));
  mounted = { root, container };
  return container;
}

afterEach(() => {
  rename.mockClear();
  if (mounted) {
    act(() => mounted?.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
});

describe("SidebarWorkspaceInlineTitleField screenshot", () => {
  it("captures the active row's inline title field at desktop sidebar width", async () => {
    const container = mount(280);
    const input = container.querySelector<HTMLInputElement>('[data-testid="sidebar-inline-title"]');
    expect(input?.value).toBe(WORKSPACE.title);

    await page.screenshot({
      element: container,
      path: "../../../../../.artifacts/sidebar-workspace-inline-title-edit-desktop.png",
    });
  });
});
