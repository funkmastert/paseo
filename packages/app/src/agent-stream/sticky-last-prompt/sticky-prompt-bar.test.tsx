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

interface StickyPromptBarTestOverrides {
  compact?: boolean;
  positionLabel?: string | null;
  canStepBack?: boolean;
  canStepForward?: boolean;
  onStepBack?: () => void;
  onStepForward?: () => void;
  onJumpToSelected?: () => void;
  onJumpToOriginal?: () => void;
  onOpenViewer?: () => void;
  text?: string;
}

function renderBar(overrides: StickyPromptBarTestOverrides = {}) {
  render(
    <StickyPromptBar
      prompt={prompt(overrides.text)}
      compact={overrides.compact}
      positionLabel={overrides.positionLabel ?? null}
      canStepBack={overrides.canStepBack ?? false}
      canStepForward={overrides.canStepForward ?? false}
      onStepBack={overrides.onStepBack ?? vi.fn()}
      onStepForward={overrides.onStepForward ?? vi.fn()}
      onJumpToSelected={overrides.onJumpToSelected ?? vi.fn()}
      onJumpToOriginal={overrides.onJumpToOriginal ?? vi.fn()}
      onOpenViewer={overrides.onOpenViewer ?? vi.fn()}
    />,
  );
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
    renderBar();
    const body = query("sticky-prompt-bar-body");
    expect(body?.textContent).toContain("Fix the flaky test");
  });

  it("jumps to the selected prompt when the body is tapped, in both compact and full layout", () => {
    const onJumpToSelected = vi.fn();
    renderBar({ compact: true, onJumpToSelected });
    act(() => {
      query("sticky-prompt-bar-body")?.click();
    });
    expect(onJumpToSelected).toHaveBeenCalledTimes(1);
  });

  it("opens the full viewer from the expand icon, not the body", () => {
    const onOpenViewer = vi.fn();
    const onJumpToSelected = vi.fn();
    renderBar({ onOpenViewer, onJumpToSelected });
    act(() => {
      query("sticky-prompt-bar-expand")?.click();
    });
    expect(onOpenViewer).toHaveBeenCalledTimes(1);
    expect(onJumpToSelected).not.toHaveBeenCalled();
  });

  it("calls onJumpToOriginal exactly once from the bar's own jump control without opening the viewer", () => {
    const onJump = vi.fn();
    const onOpenViewer = vi.fn();
    renderBar({ onJumpToOriginal: onJump, onOpenViewer });
    act(() => {
      query("sticky-prompt-bar-jump")?.click();
    });
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onOpenViewer).not.toHaveBeenCalled();
  });

  it("renders the position label when provided", () => {
    renderBar({ positionLabel: "3/7" });
    expect(query("sticky-prompt-bar-position")?.textContent).toBe("3/7");
  });

  it("omits the position label when there's nothing to navigate", () => {
    renderBar({ positionLabel: null });
    expect(query("sticky-prompt-bar-position")).toBeNull();
  });

  it("calls onStepBack when the back arrow is pressed and canStepBack is true", () => {
    const onStepBack = vi.fn();
    renderBar({ canStepBack: true, onStepBack });
    act(() => {
      query("sticky-prompt-bar-step-back")?.click();
    });
    expect(onStepBack).toHaveBeenCalledTimes(1);
  });

  it("does not call onStepBack when the back arrow is disabled", () => {
    const onStepBack = vi.fn();
    renderBar({ canStepBack: false, onStepBack });
    act(() => {
      query("sticky-prompt-bar-step-back")?.click();
    });
    expect(onStepBack).not.toHaveBeenCalled();
  });

  it("calls onStepForward when the forward arrow is pressed and canStepForward is true", () => {
    const onStepForward = vi.fn();
    renderBar({ canStepForward: true, onStepForward });
    act(() => {
      query("sticky-prompt-bar-step-forward")?.click();
    });
    expect(onStepForward).toHaveBeenCalledTimes(1);
  });

  it("does not call onStepForward when the forward arrow is disabled", () => {
    const onStepForward = vi.fn();
    renderBar({ canStepForward: false, onStepForward });
    act(() => {
      query("sticky-prompt-bar-step-forward")?.click();
    });
    expect(onStepForward).not.toHaveBeenCalled();
  });

  it("renders one-line text and keeps the navigator controls present in compact mode", () => {
    renderBar({ compact: true, positionLabel: "2/5", canStepBack: true, canStepForward: true });
    expect(query("sticky-prompt-bar-step-back")).not.toBeNull();
    expect(query("sticky-prompt-bar-step-forward")).not.toBeNull();
    expect(query("sticky-prompt-bar-position")?.textContent).toBe("2/5");
    expect(query("sticky-prompt-bar-expand")).not.toBeNull();
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
