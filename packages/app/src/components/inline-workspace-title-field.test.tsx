import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InlineWorkspaceTitleField } from "./inline-workspace-title-field";
import type { RenamableWorkspace } from "@/hooks/use-workspace-rename";

const { theme, adaptiveInputState, rename, toastError } = vi.hoisted(() => ({
  adaptiveInputState: {
    latestProps: null as {
      onChangeText?: (next: string) => void;
      onSubmitEditing?: () => void;
      onBlur?: () => void;
      onKeyPress?: (event: { nativeEvent: { key: string } }) => void;
    } | null,
  },
  theme: {
    fontSize: { base: 15 },
    colors: { foreground: "#fff" },
  },
  rename: vi.fn(() => Promise.resolve()),
  toastError: vi.fn(),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
  withUnistyles: (Component: unknown) => Component,
}));

vi.mock("@/hooks/use-workspace-rename", () => ({
  useWorkspaceRename: () => ({ rename, isPending: false, error: null }),
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), info: vi.fn() }),
}));

vi.mock("@/components/adaptive-text-input", async () => {
  const ReactModule = await import("react");
  const AdaptiveTextInput = ReactModule.forwardRef<unknown, Record<string, unknown>>(
    (props, ref) => {
      const p = props as {
        initialValue?: string;
        testID?: string;
        placeholder?: string;
        onChangeText?: (next: string) => void;
        onSubmitEditing?: () => void;
        onBlur?: () => void;
        onKeyPress?: (event: { nativeEvent: { key: string } }) => void;
      };
      adaptiveInputState.latestProps = {
        onChangeText: p.onChangeText,
        onSubmitEditing: p.onSubmitEditing,
        onBlur: p.onBlur,
        onKeyPress: p.onKeyPress,
      };
      const inputRef = ReactModule.useRef<HTMLInputElement | null>(null);
      // Mirrors the real `EditingTextInputHandle` contract: the component's ref is a handle
      // object, never the raw DOM node.
      ReactModule.useImperativeHandle(ref, () => ({
        focus: () => inputRef.current?.focus(),
        blur: () => inputRef.current?.blur(),
        isFocused: () => document.activeElement === inputRef.current,
        getText: () => inputRef.current?.value ?? "",
        replaceText: (text: string, selection?: { start: number; end: number }) => {
          if (!inputRef.current) return;
          inputRef.current.value = text;
          if (selection) inputRef.current.setSelectionRange(selection.start, selection.end);
        },
        reset: () => {
          if (inputRef.current) inputRef.current.value = "";
        },
        getNativeRef: () => inputRef.current,
      }));
      return ReactModule.createElement("input", {
        ref: inputRef,
        defaultValue: p.initialValue ?? "",
        placeholder: p.placeholder,
        "data-testid": p.testID,
        onChange: (e: { target: { value: string } }) => p.onChangeText?.(e.target.value),
      });
    },
  );
  return { AdaptiveTextInput };
});

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("HTMLInputElement", dom.window.HTMLInputElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  adaptiveInputState.latestProps = null;
  rename.mockClear();
  toastError.mockClear();
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

const WORKSPACE: RenamableWorkspace = {
  serverId: "server-1",
  workspaceId: "workspace-1",
  name: "Fix the CPU spike",
  title: "Fix the CPU spike",
};

function render(onDone: () => void, workspace: RenamableWorkspace = WORKSPACE): void {
  act(() => {
    root?.render(
      <InlineWorkspaceTitleField
        workspace={workspace}
        onDone={onDone}
        variant="row"
        testID="sidebar-inline-title"
      />,
    );
  });
}

function queryInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('[data-testid="sidebar-inline-title"]');
}

async function flush(): Promise<void> {
  await act(async () => {
    // Also settles the mount effect's `setTimeout(..., 0)` (focus + select), so it never fires
    // unobserved during a later test.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("InlineWorkspaceTitleField", () => {
  it("mounts prefilled with the current title", async () => {
    const onDone = vi.fn();
    render(onDone);

    expect(queryInput()?.value).toBe("Fix the CPU spike");
    await flush();
  });

  it("Enter saves and calls onDone once", async () => {
    const onDone = vi.fn();
    render(onDone);
    adaptiveInputState.latestProps?.onChangeText?.("New name");
    act(() => adaptiveInputState.latestProps?.onSubmitEditing?.());
    await flush();

    expect(rename).toHaveBeenCalledWith("New name");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("blur saves through the same rename path", async () => {
    const onDone = vi.fn();
    render(onDone);
    adaptiveInputState.latestProps?.onChangeText?.("Blurred name");
    act(() => adaptiveInputState.latestProps?.onBlur?.());
    await flush();

    expect(rename).toHaveBeenCalledWith("Blurred name");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("Escape cancels without saving", async () => {
    const onDone = vi.fn();
    render(onDone);
    adaptiveInputState.latestProps?.onChangeText?.("Should not save");
    act(() => adaptiveInputState.latestProps?.onKeyPress?.({ nativeEvent: { key: "Escape" } }));
    await flush();

    expect(rename).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("an empty value hands naming back to Paseo", async () => {
    const onDone = vi.fn();
    render(onDone);
    adaptiveInputState.latestProps?.onChangeText?.("");
    act(() => adaptiveInputState.latestProps?.onSubmitEditing?.());
    await flush();

    expect(rename).toHaveBeenCalledWith("");
  });

  it("does not double-fire onDone when Enter is followed by blur", async () => {
    const onDone = vi.fn();
    render(onDone);
    adaptiveInputState.latestProps?.onChangeText?.("New name");
    act(() => adaptiveInputState.latestProps?.onSubmitEditing?.());
    act(() => adaptiveInputState.latestProps?.onBlur?.());
    await flush();

    expect(rename).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
