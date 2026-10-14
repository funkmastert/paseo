import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Side-effecting: creating the instance is what registers it with react-i18next.
// eslint-disable-next-line import/no-unassigned-import
import "@/i18n/i18next";
import { ToastProvider } from "@/contexts/toast-context";
import { BroadcastPinnedButton } from "./broadcast-pinned-button";
import type { BroadcastSendResult } from "./broadcast-pinned-send";
import type { BroadcastPinnedTarget } from "./broadcast-pinned-targets";

// This is the only browser test that mounts DropdownMenu, whose floating surface runs a real
// Reanimated web Keyframe entering animation (menu-overlay.tsx). Under this Vite/Playwright
// harness, react-native-reanimated's web `createReactDOMStyle` helper never initializes — its
// internal `require("react-native-web/...")` (webUtils.web.ts) is a no-op outside Metro's module
// system — so when the animation's native `animationstart` event fires on a still-mounted
// surface, `_updatePropsJS` falls through reanimated's dead legacy branch (`Object.keys(ref.props)`
// on a plain DOM node with no `.props`) and throws, asynchronously, outside any `act()` this test
// can observe. Stub in the same passthrough `createReactDOMStyle` Metro would have supplied, so
// reanimated's own update path runs as intended; this test doesn't assert on the resulting CSS.
vi.mock("react-native-reanimated/lib/module/ReanimatedModule/js-reanimated/webUtils", () => ({
  createReactDOMStyle: (style: Record<string, unknown>) => style,
  createTransformValue: undefined,
  createTextShadowValue: undefined,
}));

beforeEach(() => vi.stubGlobal("React", React));

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

function mount(node: ReactNode): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  const entry = { root, container };
  mounted.push(entry);
  return entry;
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function click(element: Element): void {
  act(() => {
    (element as HTMLElement).click();
  });
}

function typeInto(textarea: HTMLTextAreaElement, text: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!valueSetter) {
    throw new Error("HTML textarea value setter is unavailable");
  }
  act(() => {
    valueSetter.call(textarea, text);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  });
}

function byTestId(testID: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testID}"]`);
}

function target(input: Partial<BroadcastPinnedTarget> & { id: string }): BroadcastPinnedTarget {
  return {
    serverId: "host-1",
    workspaceId: "ws-1",
    workspaceName: "Chat",
    label: input.id,
    agentTitle: null,
    status: "idle",
    ...input,
  };
}

function okResult(ids: string[]): BroadcastSendResult {
  return { succeeded: ids, failed: [] };
}

describe("BroadcastPinnedButton", () => {
  it("renders nothing when there are no targets", () => {
    mount(
      <ToastProvider>
        <BroadcastPinnedButton targets={[]} onSend={vi.fn()} />
      </ToastProvider>,
    );
    expect(byTestId("sidebar-pinned-broadcast")).toBeNull();
  });

  it("renders the trigger when at least one target exists", () => {
    mount(
      <ToastProvider>
        <BroadcastPinnedButton targets={[target({ id: "a1" })]} onSend={vi.fn()} />
      </ToastProvider>,
    );
    expect(byTestId("sidebar-pinned-broadcast")).not.toBeNull();
  });

  it("opens with every target checked by default, and lets one be deselected", () => {
    mount(
      <ToastProvider>
        <BroadcastPinnedButton
          targets={[target({ id: "a1" }), target({ id: "a2" })]}
          onSend={vi.fn().mockResolvedValue(okResult(["a1", "a2"]))}
        />
      </ToastProvider>,
    );

    click(byTestId("sidebar-pinned-broadcast") as Element);

    const rowA1 = byTestId("broadcast-pinned-target-a1");
    const rowA2 = byTestId("broadcast-pinned-target-a2");
    expect(rowA1?.getAttribute("aria-checked")).toBe("true");
    expect(rowA2?.getAttribute("aria-checked")).toBe("true");

    click(rowA2 as Element);
    expect(byTestId("broadcast-pinned-target-a2")?.getAttribute("aria-checked")).toBe("false");
    expect(byTestId("broadcast-pinned-target-a1")?.getAttribute("aria-checked")).toBe("true");
  });

  it("does not send while the prompt is empty", () => {
    const onSend = vi.fn().mockResolvedValue(okResult(["a1"]));
    mount(
      <ToastProvider>
        <BroadcastPinnedButton targets={[target({ id: "a1" })]} onSend={onSend} />
      </ToastProvider>,
    );

    click(byTestId("sidebar-pinned-broadcast") as Element);
    click(byTestId("broadcast-pinned-send") as Element);

    expect(onSend).not.toHaveBeenCalled();
  });

  it("sends the typed text to every checked target and closes on full success", async () => {
    const onSend = vi.fn().mockResolvedValue(okResult(["a1"]));
    mount(
      <ToastProvider>
        <BroadcastPinnedButton targets={[target({ id: "a1" })]} onSend={onSend} />
      </ToastProvider>,
    );

    click(byTestId("sidebar-pinned-broadcast") as Element);
    const textarea = byTestId("broadcast-pinned-prompt-input") as HTMLTextAreaElement;
    typeInto(textarea, "status please");
    click(byTestId("broadcast-pinned-send") as Element);

    expect(onSend).toHaveBeenCalledWith("status please", ["a1"]);
    await act(async () => {
      await Promise.resolve();
    });
    expect(byTestId("broadcast-pinned-prompt-input")).toBeNull();
  });

  it("keeps the composer open and the text intact on partial failure", async () => {
    const failedTarget = target({ id: "a2", label: "Second agent" });
    const onSend = vi.fn().mockResolvedValue({
      succeeded: ["a1"],
      failed: [{ target: failedTarget, error: "disconnected" }],
    });
    mount(
      <ToastProvider>
        <BroadcastPinnedButton targets={[target({ id: "a1" }), failedTarget]} onSend={onSend} />
      </ToastProvider>,
    );

    click(byTestId("sidebar-pinned-broadcast") as Element);
    typeInto(byTestId("broadcast-pinned-prompt-input") as HTMLTextAreaElement, "status please");
    click(byTestId("broadcast-pinned-send") as Element);

    await act(async () => {
      await Promise.resolve();
    });

    expect(onSend).toHaveBeenCalledWith("status please", ["a1", "a2"]);
    const textarea = byTestId("broadcast-pinned-prompt-input") as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    expect(textarea.value).toBe("status please");
  });

  it("stays open with an empty state when targets drop to zero while open", () => {
    const onSend = vi.fn();
    const { root } = mount(
      <ToastProvider>
        <BroadcastPinnedButton targets={[target({ id: "a1" })]} onSend={onSend} />
      </ToastProvider>,
    );

    click(byTestId("sidebar-pinned-broadcast") as Element);
    typeInto(byTestId("broadcast-pinned-prompt-input") as HTMLTextAreaElement, "status please");

    act(() => {
      root.render(
        <ToastProvider>
          <BroadcastPinnedButton targets={[]} onSend={onSend} />
        </ToastProvider>,
      );
    });

    const textarea = byTestId("broadcast-pinned-prompt-input") as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    expect(textarea.value).toBe("status please");

    expect(byTestId("broadcast-pinned-no-targets")).not.toBeNull();

    const sendButton = byTestId("broadcast-pinned-send");
    expect(sendButton?.getAttribute("data-menu-disabled")).toBe("true");

    expect(onSend).not.toHaveBeenCalled();
  });
});
