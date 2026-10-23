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

// The shared stubs draw no icons and drop `uniProps`, which would leave the chevrons and button
// icons out of the captures. Here the strip's icons draw lucide's own path data (lucide-react's
// components would bring a second React), coloured the way the theme mapping would colour them;
// every other name falls back to the stub.
vi.mock("lucide-react-native", async (importOriginal) => {
  const { createElement, forwardRef } = await import("react");
  type IconNode = Array<[string, Record<string, string>]>;
  const paths: Record<string, IconNode> = {
    ChevronDown: [["path", { d: "m6 9 6 6 6-6" }]],
    ChevronUp: [["path", { d: "m18 15-6-6-6 6" }]],
    Copy: [
      ["rect", { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2" }],
      ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }],
    ],
    ExternalLink: [
      ["path", { d: "M15 3h6v6" }],
      ["path", { d: "M10 14 21 3" }],
      ["path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" }],
    ],
    EyeOff: [
      [
        "path",
        {
          d: "M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49",
        },
      ],
      ["path", { d: "M14.084 14.158a3 3 0 0 1-4.242-4.242" }],
      [
        "path",
        {
          d: "M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143",
        },
      ],
      ["path", { d: "m2 2 20 20" }],
    ],
    KeyRound: [
      [
        "path",
        {
          d: "M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z",
        },
      ],
      ["circle", { cx: "16.5", cy: "7.5", r: ".5", fill: "currentColor" }],
    ],
    Server: [
      ["rect", { width: "20", height: "8", x: "2", y: "2", rx: "2", ry: "2" }],
      ["rect", { width: "20", height: "8", x: "2", y: "14", rx: "2", ry: "2" }],
      ["line", { x1: "6", x2: "6.01", y1: "6", y2: "6" }],
      ["line", { x1: "6", x2: "6.01", y1: "18", y2: "18" }],
    ],
  };
  // forwardRef, like the real icons: <Button> reads a plain one-argument function as a render
  // callback and would hand it a colour string.
  function drawIcon(node: IconNode) {
    const children = node.map(([tag, attrs], index) =>
      createElement(tag, { ...attrs, key: index }),
    );
    return forwardRef<SVGSVGElement, { size?: number; color?: string }>(
      ({ size = 24, color = "currentColor" }, ref) =>
        createElement(
          "svg",
          {
            ref,
            width: size,
            height: size,
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: color,
            strokeWidth: 2,
            strokeLinecap: "round",
            strokeLinejoin: "round",
          },
          children,
        ),
    );
  }
  const icons = Object.fromEntries(
    Object.entries(paths).map(([name, node]) => [name, drawIcon(node)]),
  );
  return { ...(await importOriginal<Record<string, unknown>>()), ...icons };
});
vi.mock("react-native-unistyles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native-unistyles")>();
  // The stub's create() hands its factory the test theme; asking for it back is how to get it.
  const createStyles = actual.StyleSheet.create as unknown as (
    factory: (value: unknown) => unknown,
  ) => unknown;
  const theme = createStyles((value) => value);
  interface Props {
    uniProps?: (value: unknown) => Record<string, unknown>;
  }
  return {
    ...actual,
    withUnistyles:
      <P extends object>(Component: React.ComponentType<P>) =>
      ({ uniProps, ...props }: P & Props) => (
        <Component {...(props as P)} {...(uniProps ? uniProps(theme) : {})} />
      ),
  };
});

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
    "stripe",
    "zeeq",
  ].map(connected),
  { ...connected("sentry"), status: "connecting" },
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
      pendingNames: new Set(),
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
    // More is a ghost button; its label's ink is what sits on the rail.
    const moreLabel = rect(buttonLabel(byTestId(container, "mcp-status-more-figma")));
    const figmaSecondLine = rect(byTestId(container, "mcp-status-second-line-figma"));
    expect(Math.abs(moreLabel.left - figmaSecondLine.left)).toBeLessThanOrEqual(1);
  });

  it("runs the second line under the button, out to the trailing rail", () => {
    const { container } = mountStrip();
    const trailingRail = rect(byTestId(container, "mcp-status-auth-linear")).right;
    for (const server of ["linear", "claude.ai Robinhood"]) {
      const secondLine = rect(byTestId(container, `mcp-status-second-line-${server}`));
      const nameLine = rect(byTestId(container, `mcp-status-name-${server}`));
      expect(Math.abs(secondLine.right - trailingRail)).toBeLessThanOrEqual(1);
      // A short message is one line again: "Sign-in failed: Invalid refresh token".
      expect(secondLine.height).toBeLessThanOrEqual(nameLine.height + 1);
    }
  });

  it("keeps More muted and on the line right under the sentence it opens", async () => {
    const { container } = mountStrip();
    await settle();
    const more = byTestId(container, "mcp-status-more-figma");
    const label = buttonLabel(more);
    const secondLine = byTestId(container, "mcp-status-second-line-figma");
    expect(more?.getAttribute("role")).toBe("button");
    expect(getComputedStyle(label as Element).color).toBe(
      getComputedStyle(secondLine as Element).color,
    );
    // The label lands on the next line of the sentence, as plain text would.
    expect(Math.abs(rect(label).top - rect(secondLine).bottom)).toBeLessThanOrEqual(2);
  });

  it("waits only on the row whose sign-in is in flight", () => {
    const { container } = mountStrip({ pendingNames: new Set(["linear"]) });
    const disabled = (id: string) => byTestId(container, id)?.getAttribute("aria-disabled");
    expect(disabled("mcp-status-auth-linear")).toBe("true");
    expect(disabled("mcp-status-auth-notion")).toBeNull();
    expect(disabled("mcp-status-auth-claude.ai Robinhood")).toBeNull();
  });

  it("hides any problem row from its context menu", async () => {
    const onHide = vi.fn();
    const { container } = mountStrip({ onHide });
    const row = rect(byTestId(container, "mcp-status-row-linear"));
    act(() => {
      byTestId(container, "mcp-status-row-linear")?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: row.left + 20,
          clientY: row.top + 10,
        }),
      );
    });
    // The menu renders outside the strip, in the app's overlay layer.
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="mcp-status-menu-hide-linear"]')).not.toBeNull(),
    );
    click(document.querySelector('[data-testid="mcp-status-menu-hide-linear"]'));
    await vi.waitFor(() => expect(onHide).toHaveBeenCalledExactlyOnceWith("linear"));
  });

  it("gives each problem row the sidebar's breathing room", () => {
    const { container } = mountStrip();
    const above = rect(byTestId(container, "mcp-status-second-line-linear")).bottom;
    const below = rect(byTestId(container, "mcp-status-name-notion")).top;
    // At least the 8px each row keeps above and below.
    expect(below - above).toBeGreaterThanOrEqual(16);
  });

  it("sets each group's label on the name rail with its chevron beside it", () => {
    const { container } = mountStrip({ model: model(["figma"]) });
    const nameRail = rect(byTestId(container, "mcp-status-name-linear")).left;
    for (const id of ["mcp-status-connected-toggle", "mcp-status-hidden-toggle"]) {
      const toggle = byTestId(container, id);
      const label = rect(buttonLabel(toggle));
      const chevron = rect(toggle?.querySelector("svg") ?? null);
      expect(Math.abs(label.left - nameRail)).toBeLessThanOrEqual(1);
      expect(chevron.left).toBeGreaterThanOrEqual(label.right);
      expect(chevron.left - label.right).toBeLessThanOrEqual(8);
      expect(getComputedStyle(buttonLabel(toggle) as Element).color).toBe(
        getComputedStyle(byTestId(container, "mcp-status-second-line-linear") as Element).color,
      );
    }
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
    // The green dot already says connected; only a state it doesn't say gets words.
    expect(byTestId(container, "mcp-status-row-zeeq")?.textContent).toBe("zeeq");
    expect(byTestId(container, "mcp-status-row-sentry")?.textContent).toBe("sentryConnecting");
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
