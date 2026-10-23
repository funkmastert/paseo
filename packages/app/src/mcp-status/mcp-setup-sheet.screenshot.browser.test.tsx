import React, { act, useMemo, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StyleSheet, Text, View } from "react-native";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/contexts/toast-context";
// Side-effecting: creating the instance is what registers it with react-i18next, so the form
// renders its real copy rather than raw keys.
// eslint-disable-next-line import/no-unassigned-import
import "@/i18n/i18next";
import { McpSetupFormBody, McpSetupFormFooter } from "./mcp-setup-sheet";
import {
  openMcpSetupForm,
  type McpSetupFormModel,
  type McpSetupKind,
} from "./mcp-setup-form-model";

// The shared stubs draw no icons; the form's two draw lucide's own path data so the captures show
// them. Every other name falls back to the stub.
vi.mock("lucide-react-native", async (importOriginal) => {
  const { createElement, forwardRef } = await import("react");
  type IconNode = Array<[string, Record<string, string>]>;
  const paths: Record<string, IconNode> = {
    Check: [["path", { d: "M20 6 9 17l-5-5" }]],
    ExternalLink: [
      ["path", { d: "M15 3h6v6" }],
      ["path", { d: "M10 14 21 3" }],
      ["path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" }],
    ],
  };
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

const openExternalUrl = vi.hoisted(() => vi.fn(async (_url: string) => {}));
vi.mock("@/utils/open-external-url", () => ({ openExternalUrl }));

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => {
  vi.stubGlobal("React", React);
  openExternalUrl.mockClear();
});

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

const CAPTURE_VIEWPORT_HEIGHT = 900;
const PAGE_BACKGROUND = "#e4e4e7";
const SHEET_BACKGROUND = "#ffffff";
const REDIRECT = "http://localhost:6767/mcp/gateway/oauth/callback";
const FAKE_TOKEN = "figd_fake-token-do-not-use";

const frameStyles = StyleSheet.create({
  frame: {
    backgroundColor: SHEET_BACKGROUND,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#d4d4d8",
    overflow: "hidden",
  },
  header: { padding: 20, borderBottomWidth: 1, borderBottomColor: "#e4e4e7" },
  title: { fontSize: 17, fontWeight: "600", color: "#18181b" },
  body: { padding: 20 },
  footer: { padding: 20, borderTopWidth: 1, borderTopColor: "#e4e4e7" },
});

interface HarnessProps {
  model: McpSetupFormModel;
  width: number;
  onSubmit: () => void;
  onSignIn: () => void;
  onCancel: () => void;
}

/** The sheet's own chrome, so a capture reads as the form it is in: a card with a title, the body
 * and the sticky footer. The real `AdaptiveModalSheet` draws the same three parts. */
function Harness({ model, width, onSubmit, onSignIn, onCancel }: HarnessProps) {
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const controlSize = width < 480 ? "md" : "sm";
  const frameStyle = useMemo(() => [frameStyles.frame, { width }], [width]);
  return (
    <View testID="sheet-frame" style={frameStyle}>
      <View style={frameStyles.header}>
        <Text style={frameStyles.title}>{`Set up ${state.displayName}`}</Text>
      </View>
      <View style={frameStyles.body}>
        <McpSetupFormBody
          state={state}
          model={model}
          controlSize={controlSize}
          onSubmit={onSubmit}
        />
      </View>
      <View style={frameStyles.footer}>
        <McpSetupFormFooter
          state={state}
          onCancel={onCancel}
          onSubmit={onSubmit}
          onSignIn={onSignIn}
        />
      </View>
    </View>
  );
}

function mountForm(kind: McpSetupKind, serverName: string, width: number) {
  const model = openMcpSetupForm({ kind, serverName });
  const props = { onSubmit: vi.fn(), onSignIn: vi.fn(), onCancel: vi.fn() };
  const container = document.createElement("div");
  container.style.width = `${width + 48}px`;
  container.style.padding = "24px";
  container.style.background = PAGE_BACKGROUND;
  document.body.style.margin = "0";
  document.body.style.background = PAGE_BACKGROUND;
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <ToastProvider>
        <Harness model={model} width={width} {...props} />
      </ToastProvider>,
    ),
  );
  mounted.push({ root, container });
  return { model, container, ...props };
}

function byTestId(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function inputIn(container: HTMLElement, id: string): HTMLInputElement | HTMLTextAreaElement {
  const host = byTestId(container, id);
  const input = host?.matches("input,textarea") ? host : host?.querySelector("input,textarea");
  if (!input) throw new Error(`no input for ${id}`);
  return input as HTMLInputElement | HTMLTextAreaElement;
}

function type(container: HTMLElement, id: string, text: string): void {
  const input = inputIn(container, id);
  const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set;
  if (!setter) throw new Error("value setter unavailable");
  act(() => {
    setter.call(input, text);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  });
}

function click(element: Element | null | undefined): void {
  if (!element) throw new Error("nothing to click");
  act(() => {
    (element as HTMLElement).click();
  });
}

function failSave(model: McpSetupFormModel, message: string): void {
  act(() => model.saveFailed(message));
}

function failDescribe(model: McpSetupFormModel, message: string): void {
  act(() => model.describeFailed(message));
}

function attempt(model: McpSetupFormModel): void {
  act(() => {
    model.attemptSubmit();
  });
}

function saveCredentials(model: McpSetupFormModel): void {
  act(() => {
    model.beginSaving();
    model.saveSucceeded();
  });
}

function describeReady(model: McpSetupFormModel, clientIdSet = false): void {
  act(() =>
    model.applyDescription({
      redirectUrl: REDIRECT,
      clientIdSet,
      clientId: clientIdSet ? "123.456" : "",
      clientSecretSet: clientIdSet,
      tokenSet: false,
    }),
  );
}

function isDisabled(element: HTMLElement | null): boolean {
  if (!element) throw new Error("no element");
  return element.getAttribute("aria-disabled") === "true" || element.hasAttribute("disabled");
}

async function settle(): Promise<void> {
  // Layout reaches react-native-web through a ResizeObserver, a frame or two after mount.
  await new Promise((resolve) => setTimeout(resolve, 100));
}

describe.each([
  { name: "desktop", width: 520 },
  { name: "phone", width: 366 },
])("MCP setup forms on $name", ({ name, width }) => {
  describe("Figma: set up with a token", () => {
    it("asks for a token in a secret field and links to where to get one", () => {
      const { container } = mountForm("local_token", "figma", width);
      expect(inputIn(container, "mcp-setup-token-input").getAttribute("type")).toBe("password");
      expect(byTestId(container, "mcp-setup-form")?.textContent).toContain(
        "Settings → Security → Personal access tokens",
      );
      click(byTestId(container, "mcp-setup-get-token"));
      expect(openExternalUrl).toHaveBeenCalledWith("https://www.figma.com/settings");
    });

    it("saves only once there is a token, and runs the save from the footer", () => {
      const { container, model, onSubmit } = mountForm("local_token", "figma", width);
      expect(isDisabled(byTestId(container, "mcp-setup-footer-save"))).toBe(true);
      type(container, "mcp-setup-token-input", "   ");
      expect(isDisabled(byTestId(container, "mcp-setup-footer-save"))).toBe(true);
      type(container, "mcp-setup-token-input", FAKE_TOKEN);
      expect(model.getState().token).toBe(FAKE_TOKEN);
      expect(isDisabled(byTestId(container, "mcp-setup-footer-save"))).toBe(false);
      click(byTestId(container, "mcp-setup-footer-save"));
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it("shows what the daemon said when the save fails, and lets the person try again", () => {
      const { container, model } = mountForm("local_token", "figma", width);
      type(container, "mcp-setup-token-input", FAKE_TOKEN);
      failSave(model, "Couldn't install the local server: npm ERR! 404");
      expect(byTestId(container, "mcp-setup-submit-error")?.textContent).toBe(
        "Couldn't install the local server: npm ERR! 404",
      );
      expect(isDisabled(byTestId(container, "mcp-setup-footer-save"))).toBe(false);
    });

    it("shows a validation error only after a first attempt", () => {
      const { container, model } = mountForm("local_token", "figma", width);
      expect(byTestId(container, "mcp-setup-token-field-error")).toBeNull();
      attempt(model);
      expect(byTestId(container, "mcp-setup-token-field-error")?.textContent).toBe("Required");
    });
  });

  describe("Slack: create a Slack app", () => {
    it("walks three steps, with the app link disabled until the daemon has said where to redirect", () => {
      const { container, model } = mountForm("client_credentials", "slack", width);
      const text = byTestId(container, "mcp-setup-form")?.textContent ?? "";
      expect(text).toContain("1. Create the app");
      expect(text).toContain("2. Paste its credentials");
      expect(text).toContain("3. Sign in");
      expect(isDisabled(byTestId(container, "mcp-setup-create-app"))).toBe(true);
      describeReady(model);
      expect(isDisabled(byTestId(container, "mcp-setup-create-app"))).toBe(false);
    });

    it("opens Slack's new-app flow with a read-only manifest for this daemon's redirect", () => {
      const { container, model } = mountForm("client_credentials", "slack", width);
      describeReady(model);
      click(byTestId(container, "mcp-setup-create-app"));
      expect(openExternalUrl).toHaveBeenCalledTimes(1);
      const opened = new URL(String(openExternalUrl.mock.calls[0]?.[0]));
      expect(`${opened.origin}${opened.pathname}`).toBe("https://api.slack.com/apps");
      expect(opened.searchParams.get("new_app")).toBe("1");
      const manifest = JSON.parse(opened.searchParams.get("manifest_json") ?? "null");
      expect(manifest.display_information.name).toBe("Paseo MCP");
      expect(manifest.oauth_config.redirect_urls).toEqual([REDIRECT]);
      expect(manifest.oauth_config.scopes.user.join(" ")).not.toMatch(/:write/);
    });

    it("tells the person a workspace may need an admin to approve the app", () => {
      const { container } = mountForm("client_credentials", "slack", width);
      expect(byTestId(container, "mcp-setup-admin-note")?.textContent).toContain("admin");
    });

    it("keeps the secret hidden, saves only with a client id, and unlocks Sign in after saving", () => {
      const { container, model, onSubmit, onSignIn } = mountForm(
        "client_credentials",
        "slack",
        width,
      );
      describeReady(model);
      expect(inputIn(container, "mcp-setup-client-secret-input").getAttribute("type")).toBe(
        "password",
      );
      expect(isDisabled(byTestId(container, "mcp-setup-save"))).toBe(true);
      expect(isDisabled(byTestId(container, "mcp-setup-sign-in"))).toBe(true);

      type(container, "mcp-setup-client-id-input", "123.456");
      type(container, "mcp-setup-client-secret-input", "slack-fake-secret-do-not-use");
      expect(isDisabled(byTestId(container, "mcp-setup-save"))).toBe(false);
      click(byTestId(container, "mcp-setup-save"));
      expect(onSubmit).toHaveBeenCalledTimes(1);

      saveCredentials(model);
      expect(byTestId(container, "mcp-setup-credentials-saved")).not.toBeNull();
      expect(isDisabled(byTestId(container, "mcp-setup-sign-in"))).toBe(false);
      click(byTestId(container, "mcp-setup-sign-in"));
      expect(onSignIn).toHaveBeenCalledTimes(1);

      // Changing a credential means the saved ones no longer match the fields.
      type(container, "mcp-setup-client-id-input", "123.457");
      expect(isDisabled(byTestId(container, "mcp-setup-sign-in"))).toBe(true);
    });

    it("says so when the daemon could not describe the setup", () => {
      const { container, model } = mountForm("client_credentials", "slack", width);
      failDescribe(model, "The daemon has no reachable address");
      expect(byTestId(container, "mcp-setup-describe-error")?.textContent).toContain(
        "The daemon has no reachable address",
      );
    });

    it("a server with no guide shows the redirect URL and an optional scope instead of the app link", () => {
      const { container, model } = mountForm("client_credentials", "other", width);
      describeReady(model);
      expect(byTestId(container, "mcp-setup-create-app")).toBeNull();
      expect(inputIn(container, "mcp-setup-redirect-input").value).toBe(REDIRECT);
      expect(byTestId(container, "mcp-setup-scope-input")).not.toBeNull();
    });
  });

  describe("captures", () => {
    beforeEach(async () => {
      await page.viewport(width + 48, CAPTURE_VIEWPORT_HEIGHT);
    });

    async function capture(element: HTMLElement | null, state: string): Promise<void> {
      if (!element) throw new Error(`nothing to capture for ${state}`);
      await page.screenshot({ element, path: `/tmp/mcp-setup-${state}-${name}.png` });
    }

    it("figma: set up with a token", async () => {
      const { container } = mountForm("local_token", "figma", width);
      await settle();
      await capture(container, "figma");
    });

    it("figma: with a token typed and an install failure", async () => {
      const { container, model } = mountForm("local_token", "figma", width);
      type(container, "mcp-setup-token-input", FAKE_TOKEN);
      failSave(model, "Couldn't install the local server: npm was not found on this host");
      await settle();
      await capture(container, "figma-failed");
    });

    it("slack: create a Slack app", async () => {
      const { container, model } = mountForm("client_credentials", "slack", width);
      describeReady(model);
      await settle();
      await capture(container, "slack");
    });

    it("slack: credentials saved, ready to sign in", async () => {
      const { container, model } = mountForm("client_credentials", "slack", width);
      describeReady(model);
      type(container, "mcp-setup-client-id-input", "123456.7890123");
      type(container, "mcp-setup-client-secret-input", "slack-fake-secret-do-not-use");
      saveCredentials(model);
      await settle();
      await capture(container, "slack-saved");
    });
  });
});
