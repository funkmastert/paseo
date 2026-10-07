import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/contexts/toast-context";
// Side-effecting: creating the instance is what registers it with react-i18next, so the strip
// renders its real copy rather than raw keys.
// eslint-disable-next-line import/no-unassigned-import
import "@/i18n/i18next";
import {
  buildMcpStatusStripModel,
  type McpStatusActionFailure,
  type McpStatusServerEntry,
} from "./mcp-status-strip-model";
import { McpStatusStripView, type McpStatusStripViewProps } from "./mcp-status-strip-view";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => {
  vi.stubGlobal("React", React);
});

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

const CAPTURE_VIEWPORT_HEIGHT = 720;

// The sidebar's light surface; the unistyles stub renders the light theme.
const SIDEBAR_BACKGROUND = "#f4f4f5";

function mount(node: ReactNode, width: number): HTMLDivElement {
  const container = document.createElement("div");
  container.style.width = `${width}px`;
  container.style.background = SIDEBAR_BACKGROUND;
  document.body.style.margin = "0";
  document.body.style.width = `${width}px`;
  document.body.style.background = SIDEBAR_BACKGROUND;
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<ToastProvider>{node}</ToastProvider>));
  mounted.push({ root, container });
  return container;
}

function failure(overrides: Partial<McpStatusActionFailure>): McpStatusActionFailure {
  return {
    reason: null,
    remedyCommand: null,
    remedyPath: null,
    remedyRedirectUrl: null,
    error: "",
    ...overrides,
  };
}

const connected = (name: string): McpStatusServerEntry => ({
  name,
  status: "connected",
  critical: false,
  lastChangedAt: 1,
});
const needsAuth = (name: string): McpStatusServerEntry => ({
  ...connected(name),
  status: "needs-auth",
});

// The strip from Tyler's screenshot, fake paths throughout.
const SERVERS: McpStatusServerEntry[] = [
  ...[
    "agent-gateway",
    "amplitude",
    "github",
    "jira",
    "playwright",
    "postgres",
    "sentry",
    "stripe",
    "zeeq",
  ].map(connected),
  needsAuth("figma"),
  needsAuth("linear"),
  needsAuth("notion"),
  needsAuth("slack"),
];

const FAILURES: Record<string, McpStatusActionFailure> = {
  figma: failure({
    reason: "client_registration_refused",
    error: "The provider refused dynamic client registration",
  }),
  linear: failure({ reason: "authorization_failed", error: "Invalid refresh token" }),
  notion: failure({ reason: "authorization_failed", error: "Invalid refresh token" }),
  slack: failure({
    reason: "client_not_registered",
    remedyPath: "/home/someone/.paseo/mcp-gateway/tokens.json",
    error: "slack does not support dynamic client registration",
  }),
};

function model(hiddenNames: readonly string[] = []) {
  return buildMcpStatusStripModel({
    servers: SERVERS,
    sessionReports: [
      {
        agentId: "agent-1",
        agentLabel: "Review the login flow",
        provider: "claude-2",
        serverName: "claude.ai Robinhood",
        status: "needs-auth",
      },
      {
        agentId: "agent-2",
        agentLabel: "Fix the build",
        provider: "claude-2",
        serverName: "claude.ai Robinhood",
        status: "needs-auth",
      },
    ],
    canAdopt: true,
    failures: FAILURES,
    hiddenNames,
  });
}

function click(element: Element | null | undefined): void {
  if (!element) throw new Error("nothing to click");
  act(() => {
    (element as HTMLElement).click();
  });
}

function byTestId(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function rect(element: Element | null): DOMRect {
  if (!element) throw new Error("no element to measure");
  return element.getBoundingClientRect();
}

/** The label inside a <Button>: the last text-bearing child of its pressable. */
function buttonLabel(button: HTMLElement | null): HTMLElement | null {
  const texts = Array.from(button?.querySelectorAll<HTMLElement>("div, span") ?? []).filter(
    (node) => node.childElementCount === 0 && (node.textContent ?? "").length > 0,
  );
  return texts.at(-1) ?? null;
}

describe.each([
  { name: "desktop", width: 320 },
  { name: "phone", width: 390 },
])("MCP status strip on $name", ({ name, width }) => {
  function mountStrip(overrides: Partial<McpStatusStripViewProps> = {}) {
    const props: McpStatusStripViewProps = {
      model: model(),
      expanded: true,
      onToggleExpanded: vi.fn(),
      actionDisabled: false,
      onAction: vi.fn(),
      onHide: vi.fn(),
      onUnhide: vi.fn(),
      onCopyFailure: vi.fn(),
      ...overrides,
    };
    return { container: mount(<McpStatusStripView {...props} />, width), props };
  }

  async function settle(): Promise<void> {
    // onLayout reaches react-native-web through a ResizeObserver, a frame or two after mount.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  it("counts the problems in the header instead of listing them", () => {
    const { container } = mountStrip({ expanded: false });
    expect(byTestId(container, "mcp-status-summary-text")?.textContent).toBe(
      "5 MCP servers need attention",
    );
    expect(byTestId(container, "mcp-status-rows")).toBeNull();
  });

  it("lists the rows with a button first, the dead ends next, and folds the connected ones", () => {
    const { container } = mountStrip();
    const shown = Array.from(container.querySelectorAll('[data-testid^="mcp-status-row-"]'))
      .map((node) => node.getAttribute("data-testid"))
      .filter((id) => !id?.startsWith("mcp-status-row-menu-"));
    expect(shown).toEqual([
      "mcp-status-row-claude.ai Robinhood",
      "mcp-status-row-linear",
      "mcp-status-row-notion",
      "mcp-status-row-figma",
      "mcp-status-row-slack",
    ]);
    expect(byTestId(container, "mcp-status-connected-toggle")?.textContent).toBe("9 connected");
  });

  it("says each failure once, in place of the status", () => {
    const { container } = mountStrip();
    expect(byTestId(container, "mcp-status-second-line-linear")?.textContent).toBe(
      "Sign-in failed: Invalid refresh token",
    );
    expect(byTestId(container, "mcp-status-row-linear")?.textContent).not.toContain(
      "Needs sign-in",
    );
    expect(byTestId(container, "mcp-status-second-line-claude.ai Robinhood")?.textContent).toBe(
      "claude.ai connector · on claude-2",
    );
  });

  it("labels the buttons as sign-ins and offers Hide where there is nothing to press", () => {
    const { container } = mountStrip();
    expect(byTestId(container, "mcp-status-auth-linear")?.textContent).toBe("Sign in");
    expect(byTestId(container, "mcp-status-auth-claude.ai Robinhood")?.textContent).toBe("Sign in");
    expect(byTestId(container, "mcp-status-auth-figma")).toBeNull();
    expect(byTestId(container, "mcp-status-hide-figma")?.textContent).toBe("Hide");
    expect(byTestId(container, "mcp-status-hide-linear")).toBeNull();
  });

  it("hides a dead end from its Hide button", () => {
    const onHide = vi.fn();
    const { container } = mountStrip({ onHide });
    click(byTestId(container, "mcp-status-hide-slack"));
    expect(onHide).toHaveBeenCalledExactlyOnceWith("slack");
  });

  it("offers More only where there is more to read, and Copy only once it is open", async () => {
    const { container } = mountStrip();
    await settle();
    expect(byTestId(container, "mcp-status-more-linear")).toBeNull();
    expect(byTestId(container, "mcp-status-more-figma")?.textContent).toBe("More");
    expect(byTestId(container, "mcp-status-more-slack")?.textContent).toBe("More");
    expect(container.querySelector('[data-testid^="mcp-status-copy-error-"]')).toBeNull();

    click(byTestId(container, "mcp-status-more-slack"));
    expect(byTestId(container, "mcp-status-more-slack")?.textContent).toBe("Less");
    expect(byTestId(container, "mcp-status-remedy-path-slack")?.textContent).toBe(
      "/home/someone/.paseo/mcp-gateway/tokens.json",
    );
    expect(byTestId(container, "mcp-status-copy-error-slack")?.textContent).toBe("Copy");
  });

  it("sits the dot on the name's line and starts everything under the name on its rail", async () => {
    const { container } = mountStrip();
    await settle();
    for (const server of ["linear", "figma"]) {
      const dot = rect(byTestId(container, `mcp-status-dot-${server}`));
      const nameRect = rect(byTestId(container, `mcp-status-name-${server}`));
      const dotCenter = dot.top + dot.height / 2;
      const nameCenter = nameRect.top + nameRect.height / 2;
      expect(Math.abs(dotCenter - nameCenter)).toBeLessThanOrEqual(1);

      const secondLine = rect(byTestId(container, `mcp-status-second-line-${server}`));
      expect(secondLine.left).toBe(nameRect.left);
    }
    expect(rect(byTestId(container, "mcp-status-more-figma")).left).toBe(
      rect(byTestId(container, "mcp-status-second-line-figma")).left,
    );
  });

  it("ends every trailing control's ink on one rail", () => {
    const { container } = mountStrip();
    const outline = rect(byTestId(container, "mcp-status-auth-linear")).right;
    const ghostLabel = rect(buttonLabel(byTestId(container, "mcp-status-hide-figma"))).right;
    expect(Math.abs(outline - ghostLabel)).toBeLessThanOrEqual(1);
  });

  it("opens the connected group into one line per server", () => {
    const { container } = mountStrip();
    expect(byTestId(container, "mcp-status-row-zeeq")).toBeNull();
    click(byTestId(container, "mcp-status-connected-toggle"));
    expect(byTestId(container, "mcp-status-row-zeeq")?.textContent).toBe("zeeqConnected");
  });

  it("moves hidden rows under their own fold, where they can be unhidden", () => {
    const onUnhide = vi.fn();
    const { container } = mountStrip({
      model: model(["claude.ai Robinhood", "figma"]),
      onUnhide,
    });
    expect(byTestId(container, "mcp-status-row-figma")).toBeNull();
    expect(byTestId(container, "mcp-status-hidden-toggle")?.textContent).toBe("2 hidden");
    click(byTestId(container, "mcp-status-hidden-toggle"));
    click(byTestId(container, "mcp-status-unhide-figma"));
    expect(onUnhide).toHaveBeenCalledExactlyOnceWith("figma");
  });

  it("keeps everything inside the sidebar", async () => {
    const { container } = mountStrip();
    await settle();
    click(byTestId(container, "mcp-status-more-slack"));
    click(byTestId(container, "mcp-status-connected-toggle"));
    // Bounds, not scrollWidth: a ghost button's box deliberately reaches past its parent so its
    // label's ink can sit on the trailing rail.
    const edge = rect(container).right;
    const overflowing = Array.from(container.querySelectorAll("*")).filter(
      (node) => node.getBoundingClientRect().right > edge,
    );
    expect(overflowing.map((node) => node.getAttribute("data-testid") ?? node.tagName)).toEqual([]);
  });

  describe("captures", () => {
    // The runner scales its frame down to fit a viewport taller than its own window, and the
    // capture shrinks with it; at this height it stays at 1:1.
    beforeEach(async () => {
      await page.viewport(width, CAPTURE_VIEWPORT_HEIGHT);
    });

    async function capture(element: HTMLElement | null, state: string): Promise<void> {
      if (!element) throw new Error(`nothing to capture for ${state}`);
      await page.screenshot({
        element,
        path: `../../../../docs/assets/mcp-status-strip-${name}-${state}.png`,
      });
    }

    it("collapsed", async () => {
      const { container } = mountStrip({ expanded: false });
      await capture(container, "collapsed");
    });

    it("expanded", async () => {
      const { container } = mountStrip();
      await settle();
      await capture(container, "expanded");
    });

    it("expanded with a failure open", async () => {
      const { container } = mountStrip();
      await settle();
      click(byTestId(container, "mcp-status-more-figma"));
      await capture(container, "failure-open");
    });

    // The row alone: with its host facts open, the whole strip is taller than the runner's frame.
    it("a failure open on its host facts", async () => {
      const { container } = mountStrip();
      await settle();
      click(byTestId(container, "mcp-status-more-slack"));
      await capture(byTestId(container, "mcp-status-row-slack"), "remedy-open");
    });

    it("expanded with the connected group open", async () => {
      const { container } = mountStrip();
      await settle();
      click(byTestId(container, "mcp-status-connected-toggle"));
      await capture(container, "connected-open");
    });

    it("with two dead ends hidden", async () => {
      const { container } = mountStrip({ model: model(["claude.ai Robinhood", "figma"]) });
      await settle();
      click(byTestId(container, "mcp-status-hidden-toggle"));
      await capture(container, "hidden-open");
    });
  });
});
