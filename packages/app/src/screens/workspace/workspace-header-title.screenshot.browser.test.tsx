import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditableWorkspaceHeaderTitle } from "./workspace-header-title";
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
  name: "Fix the CPU spike",
  title: "Fix the CPU spike",
};

let mounted: { root: Root; container: HTMLDivElement } | null = null;

beforeEach(() => {
  vi.stubGlobal("React", React);
});

function mount(width: number): HTMLDivElement {
  const container = document.createElement("div");
  container.style.width = `${width}px`;
  container.style.padding = "16px";
  container.style.background = "#111318";
  document.body.style.margin = "0";
  document.body.style.width = `${width}px`;
  document.body.style.background = "#111318";
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <ToastProvider>
        <EditableWorkspaceHeaderTitle
          testID="workspace-header-title"
          title={WORKSPACE.title}
          workspace={WORKSPACE}
        />
      </ToastProvider>,
    ),
  );
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

describe("EditableWorkspaceHeaderTitle screenshots", () => {
  it("captures the editing field at desktop width", async () => {
    const container = mount(760);
    const title = container.querySelector('[data-testid="workspace-header-title"]');
    act(() => title?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="workspace-header-title-input"]',
    );
    expect(input).not.toBeNull();

    await page.screenshot({
      element: container,
      path: "../../../../../.artifacts/workspace-header-title-edit-desktop.png",
    });
  });

  it("captures the editing field at phone width", async () => {
    const container = mount(390);
    const title = container.querySelector('[data-testid="workspace-header-title"]');
    act(() => title?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="workspace-header-title-input"]',
    );
    expect(input).not.toBeNull();

    await page.screenshot({
      element: container,
      path: "../../../../../.artifacts/workspace-header-title-edit-phone.png",
    });
  });
});
