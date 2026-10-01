import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditableWorkspaceHeaderTitle } from "./workspace-header-title";
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

vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
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

function render(workspace: RenamableWorkspace | null = WORKSPACE): void {
  act(() => {
    root?.render(
      <EditableWorkspaceHeaderTitle
        testID="workspace-header-title"
        title={workspace?.title ?? "Fix the CPU spike"}
        workspace={workspace}
      />,
    );
  });
}

function queryTitle(): HTMLElement | null {
  return document.querySelector('[data-testid="workspace-header-title"]');
}

function queryInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('[data-testid="workspace-header-title-input"]');
}

function click(element: Element | null): void {
  if (!element) throw new Error("Cannot click null element");
  act(() => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    // Also settles the mount effect's `setTimeout(..., 0)` (focus + select), so it never fires
    // unobserved during a later test.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("EditableWorkspaceHeaderTitle", () => {
  it("tapping the title opens a prefilled text field", async () => {
    render();
    click(queryTitle());

    const input = queryInput();
    expect(input).not.toBeNull();
    expect(input?.value).toBe("Fix the CPU spike");
    await flush();
  });

  it("Enter saves through the rename path", async () => {
    render();
    click(queryTitle());
    adaptiveInputState.latestProps?.onChangeText?.("New name");
    act(() => adaptiveInputState.latestProps?.onSubmitEditing?.());
    await flush();

    expect(rename).toHaveBeenCalledWith("New name");
    expect(queryInput()).toBeNull();
  });

  it("blur saves through the same rename path", async () => {
    render();
    click(queryTitle());
    adaptiveInputState.latestProps?.onChangeText?.("Blurred name");
    act(() => adaptiveInputState.latestProps?.onBlur?.());
    await flush();

    expect(rename).toHaveBeenCalledWith("Blurred name");
  });

  it("Escape cancels without saving", async () => {
    render();
    click(queryTitle());
    adaptiveInputState.latestProps?.onChangeText?.("Should not save");
    act(() => adaptiveInputState.latestProps?.onKeyPress?.({ nativeEvent: { key: "Escape" } }));
    await flush();

    expect(rename).not.toHaveBeenCalled();
    expect(queryInput()).toBeNull();
  });

  it("Enter followed by the blur it causes renames once", async () => {
    render();
    click(queryTitle());
    const props = adaptiveInputState.latestProps;
    props?.onChangeText?.("New name");
    act(() => props?.onSubmitEditing?.());
    act(() => props?.onBlur?.());
    await flush();

    expect(rename).toHaveBeenCalledTimes(1);
  });

  it("Escape followed by a blur saves nothing", async () => {
    render();
    click(queryTitle());
    const props = adaptiveInputState.latestProps;
    props?.onChangeText?.("Should not save");
    act(() => props?.onKeyPress?.({ nativeEvent: { key: "Escape" } }));
    act(() => props?.onBlur?.());
    await flush();

    expect(rename).not.toHaveBeenCalled();
  });

  it("an empty value hands naming back to Paseo", async () => {
    render();
    click(queryTitle());
    adaptiveInputState.latestProps?.onChangeText?.("");
    act(() => adaptiveInputState.latestProps?.onSubmitEditing?.());
    await flush();

    expect(rename).toHaveBeenCalledWith("");
  });

  it("submitting the unchanged value does not call rename", async () => {
    render();
    click(queryTitle());
    act(() => adaptiveInputState.latestProps?.onSubmitEditing?.());
    await flush();

    expect(rename).not.toHaveBeenCalled();
  });

  it("reports a rejected rename through the toast", async () => {
    rename.mockRejectedValueOnce(new Error("Host disconnected"));
    render();
    click(queryTitle());
    adaptiveInputState.latestProps?.onChangeText?.("New name");
    act(() => adaptiveInputState.latestProps?.onSubmitEditing?.());
    await flush();

    expect(toastError).toHaveBeenCalledWith("Host disconnected");
  });

  it("a workspace that hasn't loaded yet cannot be tapped into edit", () => {
    render(null);
    click(queryTitle());

    expect(queryInput()).toBeNull();
  });
});
