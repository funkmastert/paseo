/**
 * @vitest-environment jsdom
 */
import { act } from "@testing-library/react";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserMessageItem } from "@/types/stream";
import { FullPromptViewer, StickyPromptBar } from "./sticky-prompt-bar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/adaptive-modal-sheet", async () => {
  const ReactModule = await import("react");
  const AdaptiveModalSheet = ({
    header,
    visible,
    onClose,
    onDismiss,
    children,
    testID,
  }: {
    header: { title: string; actions?: React.ReactNode };
    visible: boolean;
    onClose: () => void;
    onDismiss?: () => void;
    children: React.ReactNode;
    testID?: string;
  }) => {
    // Mirrors the real component's contract: `onDismiss` fires once the (mocked-away) close
    // transition finishes, not in the same tick as `visible` flipping false.
    ReactModule.useEffect(() => {
      if (!visible) onDismiss?.();
    }, [visible, onDismiss]);
    if (!visible) return null;
    return ReactModule.createElement(
      "div",
      { "data-testid": testID, "data-modal-title": header.title },
      ReactModule.createElement(
        "button",
        { type: "button", "data-testid": `${testID}-close`, onClick: onClose },
        "Close",
      ),
      header.actions,
      children,
    );
  };
  return { AdaptiveModalSheet };
});

function prompt(text = "Fix the flaky test"): UserMessageItem {
  return { kind: "user_message", id: "p1", text, timestamp: new Date("2026-01-01T00:00:00.000Z") };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(node: React.ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(node);
  });
}

function query(testId: string): HTMLElement | null {
  return container?.querySelector(`[data-testid="${testId}"]`) ?? null;
}

beforeEach(() => {
  vi.stubGlobal("React", React);
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container?.remove();
  container = null;
});

describe("StickyPromptBar", () => {
  it("renders two-line text by default", () => {
    render(<StickyPromptBar prompt={prompt()} onJumpToOriginal={vi.fn()} onOpenViewer={vi.fn()} />);
    const body = query("sticky-prompt-bar-body");
    expect(body?.textContent).toContain("Fix the flaky test");
  });

  it("asks to open the viewer when the body is tapped, in both compact and full layout", () => {
    const onOpenViewer = vi.fn();
    render(
      <StickyPromptBar
        prompt={prompt()}
        compact
        onJumpToOriginal={vi.fn()}
        onOpenViewer={onOpenViewer}
      />,
    );
    act(() => {
      query("sticky-prompt-bar-body")?.click();
    });
    expect(onOpenViewer).toHaveBeenCalledTimes(1);
  });

  it("calls onJumpToOriginal exactly once from the bar's own jump control without opening the viewer", () => {
    const onJump = vi.fn();
    const onOpenViewer = vi.fn();
    render(
      <StickyPromptBar prompt={prompt()} onJumpToOriginal={onJump} onOpenViewer={onOpenViewer} />,
    );
    act(() => {
      query("sticky-prompt-bar-jump")?.click();
    });
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onOpenViewer).not.toHaveBeenCalled();
  });
});

describe("FullPromptViewer", () => {
  function renderViewer(overrides: {
    visible?: boolean;
    text?: string;
    onClose?: () => void;
    onJumpToOriginal?: () => void;
    onDismiss?: () => void;
  }): void {
    render(
      <FullPromptViewer
        visible={overrides.visible ?? true}
        text={overrides.text ?? "A very long prompt that keeps going"}
        onClose={overrides.onClose ?? vi.fn()}
        onJumpToOriginal={overrides.onJumpToOriginal ?? vi.fn()}
        onDismiss={overrides.onDismiss ?? vi.fn()}
      />,
    );
  }

  it("shows the full text when visible", () => {
    renderViewer({ text: "A very long prompt that keeps going" });
    expect(query("sticky-prompt-viewer-text")?.textContent).toBe(
      "A very long prompt that keeps going",
    );
  });

  it("renders nothing when not visible", () => {
    renderViewer({ visible: false });
    expect(query("sticky-prompt-viewer")).toBeNull();
  });

  it("calls onClose, not onJumpToOriginal, from its own close control", () => {
    const onClose = vi.fn();
    const onJump = vi.fn();
    renderViewer({ onClose, onJumpToOriginal: onJump });
    act(() => {
      query("sticky-prompt-viewer-close")?.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onJump).not.toHaveBeenCalled();
  });

  it("calls onJumpToOriginal from its jump action without calling onClose", () => {
    const onClose = vi.fn();
    const onJump = vi.fn();
    renderViewer({ onClose, onJumpToOriginal: onJump });
    act(() => {
      query("sticky-prompt-viewer-jump")?.click();
    });
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});
