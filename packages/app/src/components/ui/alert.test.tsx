import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Alert } from "./alert";

const { theme } = vi.hoisted(() => ({
  theme: {
    iconSize: { sm: 16 },
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
    fontSize: { base: 16, sm: 14 },
    fontWeight: { medium: "500" },
    borderWidth: { 1: 1 },
    borderRadius: { xl: 16 },
    colors: {
      border: "#ccc",
      destructive: "#c00",
      destructiveForeground: "#fff",
      foreground: "#111",
      foregroundMuted: "#666",
      statusSuccess: "#0a0",
      palette: { blue: { 300: "#09f" }, amber: { 500: "#fa0" } },
    },
  },
}));

vi.mock("lucide-react-native", () => {
  const makeIcon =
    (name: string) =>
    ({ size, color }: { size?: number; color?: string }) =>
      React.createElement("svg", { "data-icon": name, "data-size": size, "data-color": color });
  return {
    AlertTriangle: makeIcon("alert-triangle"),
    CheckCircle2: makeIcon("check-circle-2"),
    Info: makeIcon("info"),
    X: makeIcon("x"),
    XCircle: makeIcon("x-circle"),
  };
});

vi.mock("react-native", () => ({
  Pressable: ({
    accessibilityLabel,
    accessibilityRole,
    children,
    onPress,
    testID,
    hitSlop,
  }: {
    accessibilityLabel?: string;
    accessibilityRole?: string;
    children: React.ReactNode;
    onPress?: () => void;
    testID?: string;
    hitSlop?: number;
  }) =>
    React.createElement(
      "button",
      {
        "aria-label": accessibilityLabel,
        "data-hitslop": hitSlop,
        "data-testid": testID,
        onClick: () => onPress?.(),
        role: accessibilityRole,
        type: "button",
      },
      children,
    ),
  Text: ({ children, testID }: { children: React.ReactNode; testID?: string }) =>
    React.createElement("span", { "data-testid": testID }, children),
  View: ({
    children,
    testID,
    accessibilityRole,
  }: {
    children?: React.ReactNode;
    testID?: string;
    accessibilityRole?: string;
  }) => React.createElement("div", { "data-testid": testID, role: accessibilityRole }, children),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
}));

describe("Alert", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
    vi.stubGlobal("Node", dom.window.Node);
    vi.stubGlobal("navigator", dom.window.navigator);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container = null;
    vi.unstubAllGlobals();
  });

  function renderAlert(props: React.ComponentProps<typeof Alert>): void {
    act(() => {
      root?.render(<Alert {...props} />);
    });
  }

  it("renders no close button when onDismiss is omitted", () => {
    renderAlert({ title: "Heads up", testID: "alert" });

    expect(container?.querySelector('[data-testid="alert-dismiss"]')).toBeNull();
  });

  it("renders a close button when onDismiss is provided, with its accessibility label", () => {
    renderAlert({
      title: "Heads up",
      onDismiss: vi.fn(),
      dismissAccessibilityLabel: "Dismiss",
      testID: "alert",
    });

    const dismissButton = container?.querySelector('[data-testid="alert-dismiss"]');
    expect(dismissButton).not.toBeNull();
    expect(dismissButton?.getAttribute("role")).toBe("button");
    expect(dismissButton?.getAttribute("aria-label")).toBe("Dismiss");
  });

  it("calls onDismiss when the close button is pressed", () => {
    const onDismiss = vi.fn();
    renderAlert({ title: "Heads up", onDismiss, testID: "alert" });

    const dismissButton = container?.querySelector(
      '[data-testid="alert-dismiss"]',
    ) as HTMLElement | null;
    act(() => {
      dismissButton?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders the title and close button together when both are present", () => {
    renderAlert({ title: "Heads up", onDismiss: vi.fn(), testID: "alert" });

    expect(container?.textContent).toContain("Heads up");
    expect(container?.querySelector('[data-testid="alert-dismiss"]')).not.toBeNull();
  });
});
