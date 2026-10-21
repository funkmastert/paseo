import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectStatusIndicator } from "./project-leading-visual";
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

describe("ProjectStatusIndicator", () => {
  it("renders the ready-to-merge glyph with an accessibility label on a done, pinned row", () => {
    const container = mount(
      <ProjectStatusIndicator
        iconDataUri={null}
        displayName="My Project"
        projectViewKey="project-1"
        statusBucket="done"
        backdrop="surfaceSidebar"
        completionState="ready-to-merge"
        completionNote={null}
      />,
    );
    const node = container.querySelector('[data-testid="project-completion-badge-ready-to-merge"]');
    expect(node).not.toBeNull();
    expect(node?.getAttribute("aria-label")).toBe("Ready to merge");
  });

  it("renders the done glyph with the note folded into the accessibility label", () => {
    const container = mount(
      <ProjectStatusIndicator
        iconDataUri={null}
        displayName="My Project"
        projectViewKey="project-1"
        statusBucket="done"
        backdrop="surfaceSidebar"
        completionState="done"
        completionNote="PR #41 merged"
      />,
    );
    const node = container.querySelector(
      '[data-testid="project-completion-badge-completion-done"]',
    );
    expect(node).not.toBeNull();
    expect(node?.getAttribute("aria-label")).toBe("Done — ready to archive — PR #41 merged");
  });

  it("shows the status badge, not the completion glyph, when the bucket isn't done", () => {
    const container = mount(
      <ProjectStatusIndicator
        iconDataUri={null}
        displayName="My Project"
        projectViewKey="project-1"
        statusBucket="needs_input"
        backdrop="surfaceSidebar"
        completionState="ready-to-merge"
        completionNote={null}
      />,
    );
    expect(container.querySelector('[data-testid="project-status-badge"]')).not.toBeNull();
    expect(container.querySelector('[data-testid^="project-completion-badge-"]')).toBeNull();
  });
});
