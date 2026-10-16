/**
 * @vitest-environment jsdom
 */
import { act } from "@testing-library/react";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserMessageItem } from "@/types/stream";
import { createStickyLastPromptPublisher, type StickyLastPromptSource } from "./model";
import { StickyPromptOverlay } from "./sticky-prompt-overlay";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Decouples "visible flipped false" from "the close transition actually finished": the real
// AdaptiveModalSheet fires `onDismiss` only once its own exit animation completes (a ~160ms web
// fade, a native bottom-sheet slide-down), never in the same tick `visible` goes false. This mock
// never auto-fires `onDismiss` — the test triggers it explicitly via the always-rendered
// `-simulate-dismiss-complete` button, so "jump to message" ordering (close, then jump) is
// actually observable instead of collapsing into one tick.
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
  }) =>
    ReactModule.createElement(
      ReactModule.Fragment,
      null,
      ReactModule.createElement("button", {
        type: "button",
        "data-testid": `${testID}-simulate-dismiss-complete`,
        onClick: onDismiss,
      }),
      visible
        ? ReactModule.createElement(
            "div",
            { "data-testid": testID, "data-modal-title": header.title },
            ReactModule.createElement(
              "button",
              { type: "button", "data-testid": `${testID}-close`, onClick: onClose },
              "Close",
            ),
            header.actions,
            children,
          )
        : null,
    );
  return { AdaptiveModalSheet };
});

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
  testKey,
  source,
  onJumpToOriginal,
  onJumpToSelected,
  selectedPrompt = null,
}: {
  testKey: string;
  source: StickyLastPromptSource;
  onJumpToOriginal: () => void;
  onJumpToSelected?: () => void;
  selectedPrompt?: UserMessageItem | null;
}) {
  return (
    <StickyPromptOverlay
      key={testKey}
      source={source}
      compact={false}
      onJumpToOriginal={onJumpToOriginal}
      selectedPrompt={selectedPrompt}
      positionLabel={null}
      canStepBack={false}
      canStepForward={false}
      onStepBack={vi.fn()}
      onStepForward={vi.fn()}
      onJumpToSelected={onJumpToSelected ?? vi.fn()}
    />
  );
}

describe("StickyPromptOverlay", () => {
  it("keeps the bar pinned and an open viewer mounted when barVisible flips false", () => {
    const publisher = createStickyLastPromptPublisher();
    publisher.publish({ prompt: prompt("p1"), barVisible: true });
    render(<Harness testKey="agent-1" source={publisher} onJumpToOriginal={vi.fn()} />);

    act(() => {
      query("sticky-prompt-bar-expand")?.click();
    });
    expect(query("sticky-prompt-viewer")).not.toBeNull();

    // Same prompt, back on screen: the bar is the prompt navigator, so it stays pinned, and the
    // open viewer survives.
    act(() => {
      publisher.publish({ prompt: prompt("p1"), barVisible: false });
    });

    expect(query("sticky-prompt-viewer")).not.toBeNull();
    expect(query("sticky-prompt-bar")).not.toBeNull();
  });

  it("closes the viewer when the active agent switches", () => {
    const publisherA = createStickyLastPromptPublisher();
    publisherA.publish({ prompt: prompt("p1"), barVisible: true });
    render(<Harness testKey="agent-1" source={publisherA} onJumpToOriginal={vi.fn()} />);

    act(() => {
      query("sticky-prompt-bar-expand")?.click();
    });
    expect(query("sticky-prompt-viewer")).not.toBeNull();

    const publisherB = createStickyLastPromptPublisher();
    publisherB.publish({ prompt: prompt("p2"), barVisible: true });
    rerender(<Harness testKey="agent-2" source={publisherB} onJumpToOriginal={vi.fn()} />);

    expect(query("sticky-prompt-viewer")).toBeNull();
  });

  it("sequences 'jump to message' after the sheet's own close transition finishes", () => {
    const publisher = createStickyLastPromptPublisher();
    publisher.publish({ prompt: prompt("p1"), barVisible: true });
    const onJumpToSelected = vi.fn();
    render(
      <Harness
        testKey="agent-1"
        source={publisher}
        onJumpToOriginal={vi.fn()}
        onJumpToSelected={onJumpToSelected}
      />,
    );

    act(() => {
      query("sticky-prompt-bar-expand")?.click();
    });
    act(() => {
      query("sticky-prompt-viewer-jump")?.click();
    });

    // The sheet has closed, but the dismiss-complete signal hasn't fired yet — the jump must
    // not have happened yet either.
    expect(query("sticky-prompt-viewer")).toBeNull();
    expect(onJumpToSelected).not.toHaveBeenCalled();

    act(() => {
      query("sticky-prompt-viewer-simulate-dismiss-complete")?.click();
    });
    expect(onJumpToSelected).toHaveBeenCalledTimes(1);
  });

  it("does not jump when the viewer is dismissed via its own close control", () => {
    const publisher = createStickyLastPromptPublisher();
    publisher.publish({ prompt: prompt("p1"), barVisible: true });
    const onJumpToSelected = vi.fn();
    render(
      <Harness
        testKey="agent-1"
        source={publisher}
        onJumpToOriginal={vi.fn()}
        onJumpToSelected={onJumpToSelected}
      />,
    );

    act(() => {
      query("sticky-prompt-bar-expand")?.click();
    });
    act(() => {
      query("sticky-prompt-viewer-close")?.click();
    });
    act(() => {
      query("sticky-prompt-viewer-simulate-dismiss-complete")?.click();
    });

    expect(onJumpToSelected).not.toHaveBeenCalled();
  });

  it("jumps to the selected prompt, not just the last one, when the body is tapped", () => {
    const publisher = createStickyLastPromptPublisher();
    publisher.publish({ prompt: prompt("p1", "last prompt"), barVisible: true });
    const onJumpToSelected = vi.fn();
    render(
      <Harness
        testKey="agent-1"
        source={publisher}
        onJumpToOriginal={vi.fn()}
        onJumpToSelected={onJumpToSelected}
        selectedPrompt={prompt("p0", "an older prompt")}
      />,
    );

    expect(query("sticky-prompt-bar-body")?.textContent).toContain("an older prompt");
    act(() => {
      query("sticky-prompt-bar-body")?.click();
    });
    expect(onJumpToSelected).toHaveBeenCalledTimes(1);
  });
});
