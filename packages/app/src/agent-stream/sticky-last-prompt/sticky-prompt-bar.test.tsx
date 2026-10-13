/**
 * @vitest-environment jsdom
 */
import { act } from "@testing-library/react";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserMessageItem } from "@/types/stream";
import { StickyPromptBar } from "./sticky-prompt-bar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/adaptive-modal-sheet", async () => {
  const ReactModule = await import("react");
  const AdaptiveModalSheet = ({
    header,
    visible,
    onClose,
    children,
    testID,
  }: {
    header: { title: string; actions?: React.ReactNode };
    visible: boolean;
    onClose: () => void;
    children: React.ReactNode;
    testID?: string;
  }) => {
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

function mount(props: { compact?: boolean; onJumpToOriginal: () => void; text?: string }): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <StickyPromptBar
        prompt={prompt(props.text)}
        compact={props.compact}
        onJumpToOriginal={props.onJumpToOriginal}
      />,
    );
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
    mount({ onJumpToOriginal: vi.fn() });
    const body = query("sticky-prompt-bar-body");
    expect(body?.textContent).toContain("Fix the flaky test");
    expect(query("sticky-prompt-viewer")).toBeNull();
  });

  it("opens the full-prompt viewer with the full text when the body is tapped", () => {
    const onJump = vi.fn();
    mount({ onJumpToOriginal: onJump, text: "A very long prompt that keeps going" });
    act(() => {
      query("sticky-prompt-bar-body")?.click();
    });
    const viewer = query("sticky-prompt-viewer");
    expect(viewer).not.toBeNull();
    expect(query("sticky-prompt-viewer-text")?.textContent).toBe(
      "A very long prompt that keeps going",
    );
    expect(onJump).not.toHaveBeenCalled();
  });

  it("opens the viewer when tapped in compact mode too", () => {
    const onJump = vi.fn();
    mount({ compact: true, onJumpToOriginal: onJump });
    act(() => {
      query("sticky-prompt-bar-body")?.click();
    });
    expect(query("sticky-prompt-viewer")).not.toBeNull();
    expect(onJump).not.toHaveBeenCalled();
  });

  it("calls onJumpToOriginal exactly once from the bar's own jump control without opening the viewer", () => {
    const onJump = vi.fn();
    mount({ onJumpToOriginal: onJump });
    act(() => {
      query("sticky-prompt-bar-jump")?.click();
    });
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(query("sticky-prompt-viewer")).toBeNull();
  });

  it("jumping from the viewer calls onJumpToOriginal and closes the viewer", () => {
    const onJump = vi.fn();
    mount({ onJumpToOriginal: onJump });
    act(() => {
      query("sticky-prompt-bar-body")?.click();
    });
    expect(query("sticky-prompt-viewer")).not.toBeNull();

    act(() => {
      query("sticky-prompt-viewer-jump")?.click();
    });
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(query("sticky-prompt-viewer")).toBeNull();
  });

  it("closes the viewer via its close control without jumping", () => {
    const onJump = vi.fn();
    mount({ onJumpToOriginal: onJump });
    act(() => {
      query("sticky-prompt-bar-body")?.click();
    });
    act(() => {
      query("sticky-prompt-viewer-close")?.click();
    });
    expect(onJump).not.toHaveBeenCalled();
    expect(query("sticky-prompt-viewer")).toBeNull();
  });
});
