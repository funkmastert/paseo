import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceCompletionIndicator } from "./workspace-completion-indicator";
// Side-effecting: creating the instance is what registers it with react-i18next, so the
// indicator renders real copy (its tooltip/accessibility label) rather than a raw key.
// eslint-disable-next-line import/no-unassigned-import
import "@/i18n/i18next";

let mounted: { root: Root; container: HTMLDivElement } | null = null;

beforeEach(() => {
  vi.stubGlobal("React", React);
});

function mount(node: React.ReactNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted = { root, container };
  return container;
}

afterEach(() => {
  if (mounted) {
    act(() => mounted?.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
});

describe("WorkspaceCompletionIndicator", () => {
  it("renders the ready-to-merge icon with an accessibility label", () => {
    const container = mount(
      <WorkspaceCompletionIndicator completionState="ready-to-merge" completionNote={null} />,
    );
    const node = container.querySelector(
      '[data-testid="workspace-status-indicator-ready-to-merge"]',
    );
    expect(node).not.toBeNull();
    expect(node?.getAttribute("aria-label")).toBe("Ready to merge");
  });

  it("renders the done icon with the note folded into the accessibility label", () => {
    const container = mount(
      <WorkspaceCompletionIndicator completionState="done" completionNote="PR #41 merged" />,
    );
    const node = container.querySelector(
      '[data-testid="workspace-status-indicator-completion-done"]',
    );
    expect(node).not.toBeNull();
    expect(node?.getAttribute("aria-label")).toBe("Done — ready to archive — PR #41 merged");
  });
});
