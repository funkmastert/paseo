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
    expect(query("sticky-prompt-bar-expanded")).toBeNull();
  });

  it("toggles the expanded panel when tapped in non-compact mode", () => {
    const onJump = vi.fn();
    mount({ onJumpToOriginal: onJump });
    act(() => {
      query("sticky-prompt-bar-body")?.click();
    });
    expect(query("sticky-prompt-bar-expanded")).not.toBeNull();
    expect(onJump).not.toHaveBeenCalled();

    act(() => {
      query("sticky-prompt-bar-body")?.click();
    });
    expect(query("sticky-prompt-bar-expanded")).toBeNull();
  });

  it("jumps to the original instead of expanding when tapped in compact mode", () => {
    const onJump = vi.fn();
    mount({ compact: true, onJumpToOriginal: onJump });
    act(() => {
      query("sticky-prompt-bar-body")?.click();
    });
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(query("sticky-prompt-bar-expanded")).toBeNull();
  });

  it("calls onJumpToOriginal exactly once from the jump control without toggling expand", () => {
    const onJump = vi.fn();
    mount({ onJumpToOriginal: onJump });
    act(() => {
      query("sticky-prompt-bar-jump")?.click();
    });
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(query("sticky-prompt-bar-expanded")).toBeNull();
  });
});
