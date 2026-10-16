/**
 * @vitest-environment jsdom
 */
import { act } from "@testing-library/react";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserMessageItem } from "@/types/stream";
import {
  createStickyLastPromptPublisher,
  type StickyLastPromptSource,
} from "./sticky-last-prompt/model";
import { TopOverlay } from "./top-overlay";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("react-native-reanimated", () => ({
  default: { View: "div" },
  FadeIn: { duration: () => "fade-in" },
  FadeOut: { duration: () => "fade-out" },
}));

vi.mock("lucide-react-native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react-native")>();
  return {
    ...actual,
    ArrowUpToLine: () => React.createElement("div", { "data-testid": "jump-to-start-icon" }),
  };
});

vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () => React.createElement("div", { "data-testid": "jump-to-start-spinner" }),
}));

function prompt(id: string, text = "Fix the flaky test"): UserMessageItem {
  return { kind: "user_message", id, text, timestamp: new Date("2026-01-01T00:00:00.000Z") };
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

function rerender(node: React.ReactElement): void {
  act(() => {
    root?.render(node);
  });
}

function query(testId: string): HTMLElement | null {
  return container?.querySelector(`[data-testid="${testId}"]`) ?? null;
}

function queryAll(testId: string): HTMLElement[] {
  return Array.from(container?.querySelectorAll(`[data-testid="${testId}"]`) ?? []);
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

function Harness({
  source,
  showJumpToStart = true,
  isJumpingToStart = false,
  onJumpToStart = vi.fn(),
  positionLabel = null,
  canStepBack = false,
  canStepForward = false,
  onStepBack = vi.fn(),
  onStepForward = vi.fn(),
}: {
  source: StickyLastPromptSource;
  showJumpToStart?: boolean;
  isJumpingToStart?: boolean;
  onJumpToStart?: () => void;
  positionLabel?: string | null;
  canStepBack?: boolean;
  canStepForward?: boolean;
  onStepBack?: () => void;
  onStepForward?: () => void;
}) {
  return (
    <TopOverlay
      agentId="agent-1"
      stickyPromptSource={source}
      compact={false}
      onJumpToStickyPrompt={vi.fn()}
      selectedPrompt={null}
      positionLabel={positionLabel}
      canStepBack={canStepBack}
      canStepForward={canStepForward}
      onStepBack={onStepBack}
      onStepForward={onStepForward}
      onJumpToSelected={vi.fn()}
      showJumpToStart={showJumpToStart}
      isJumpingToStart={isJumpingToStart}
      onJumpToStart={onJumpToStart}
    />
  );
}

describe("TopOverlay", () => {
  it("renders the jump-to-start button inside the top overlay", () => {
    const source = createStickyLastPromptPublisher();
    render(<Harness source={source} />);

    const overlay = query("agent-stream-top-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay?.querySelector('[data-testid="jump-to-start-button"]')).not.toBeNull();
  });

  it("does not render the jump-to-start button when showJumpToStart is false", () => {
    const source = createStickyLastPromptPublisher();
    render(<Harness source={source} showJumpToStart={false} />);

    expect(query("jump-to-start-button")).toBeNull();
  });

  it("stacks the button after the sticky bar in the same column, so it sits below it", () => {
    const source = createStickyLastPromptPublisher();
    source.publish({ prompt: prompt("p1"), barVisible: true });
    render(<Harness source={source} />);

    const overlay = query("agent-stream-top-overlay");
    const bar = query("sticky-prompt-bar");
    const button = query("jump-to-start-button");
    expect(bar).not.toBeNull();
    expect(button).not.toBeNull();

    // Both are flow children of the same top column; DOM order drives render order top-to-
    // bottom, so the bar being first in the tree is what keeps the button below it without
    // either component measuring or guessing the bar's height.
    const children = Array.from(overlay?.children ?? []);
    const barIndex = children.findIndex((el) => el.contains(bar));
    const buttonIndex = children.findIndex((el) => el.contains(button));
    expect(barIndex).toBeGreaterThanOrEqual(0);
    expect(buttonIndex).toBeGreaterThan(barIndex);
  });

  it("renders the position label and arrows inside the overlay alongside the jump-to-start button", () => {
    const source = createStickyLastPromptPublisher();
    source.publish({ prompt: prompt("p1"), barVisible: true });
    render(<Harness source={source} positionLabel="3/7" canStepBack canStepForward />);

    const overlay = query("agent-stream-top-overlay");
    expect(overlay?.querySelector('[data-testid="sticky-prompt-bar-position"]')?.textContent).toBe(
      "3/7",
    );
    expect(overlay?.querySelector('[data-testid="sticky-prompt-bar-step-back"]')).not.toBeNull();
    expect(overlay?.querySelector('[data-testid="sticky-prompt-bar-step-forward"]')).not.toBeNull();
    expect(overlay?.querySelector('[data-testid="jump-to-start-button"]')).not.toBeNull();
  });

  it("calls onStepBack/onStepForward when the overlay's navigator arrows are pressed", () => {
    const source = createStickyLastPromptPublisher();
    source.publish({ prompt: prompt("p1"), barVisible: true });
    const onStepBack = vi.fn();
    const onStepForward = vi.fn();
    render(
      <Harness
        source={source}
        canStepBack
        canStepForward
        onStepBack={onStepBack}
        onStepForward={onStepForward}
      />,
    );

    act(() => {
      query("sticky-prompt-bar-step-back")?.click();
    });
    act(() => {
      query("sticky-prompt-bar-step-forward")?.click();
    });
    expect(onStepBack).toHaveBeenCalledTimes(1);
    expect(onStepForward).toHaveBeenCalledTimes(1);
  });

  it("renders only the button, with no bar, when there is no sticky prompt", () => {
    const source = createStickyLastPromptPublisher();
    render(<Harness source={source} />);

    expect(query("sticky-prompt-bar")).toBeNull();
    expect(query("jump-to-start-button")).not.toBeNull();
  });

  it("renders exactly one jump-to-start button", () => {
    const source = createStickyLastPromptPublisher();
    source.publish({ prompt: prompt("p1"), barVisible: true });
    render(<Harness source={source} />);

    expect(queryAll("jump-to-start-button")).toHaveLength(1);
  });

  it("calls onJumpToStart when the button is pressed", () => {
    const source = createStickyLastPromptPublisher();
    const onJumpToStart = vi.fn();
    render(<Harness source={source} onJumpToStart={onJumpToStart} />);

    act(() => {
      query("jump-to-start-button")?.click();
    });

    expect(onJumpToStart).toHaveBeenCalledTimes(1);
  });

  it("shows the loading spinner instead of the arrow icon while isJumpingToStart is true", () => {
    const source = createStickyLastPromptPublisher();
    render(<Harness source={source} isJumpingToStart={false} />);
    expect(query("jump-to-start-icon")).not.toBeNull();
    expect(query("jump-to-start-spinner")).toBeNull();

    rerender(<Harness source={source} isJumpingToStart={true} />);
    expect(query("jump-to-start-icon")).toBeNull();
    expect(query("jump-to-start-spinner")).not.toBeNull();
  });
});
