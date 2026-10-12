import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import type { AccountAlertEntry } from "./account-alert-model";
import { BelowBannerInsets } from "./below-banner-insets";
import { reportHostAccountAlerts, useAccountAlertStore } from "./store";

// The unit project's stub has no context; this mirrors the library, where the hook reads the
// nearest SafeAreaInsetsContext provider.
vi.mock("react-native-safe-area-context", async () => {
  const { createContext, useContext } = await import("react");
  const Context = createContext<{
    top: number;
    right: number;
    bottom: number;
    left: number;
  } | null>(null);
  return {
    SafeAreaInsetsContext: Context,
    useSafeAreaInsets: () => {
      const insets = useContext(Context);
      if (!insets) throw new Error("No safe area insets");
      return insets;
    },
  };
});

const DEVICE_INSETS = { top: 47, right: 0, bottom: 34, left: 0 };

function entry(overrides: Partial<AccountAlertEntry> = {}): AccountAlertEntry {
  return {
    providerId: "claude-backup",
    serverId: "server-1",
    hostLabel: "Host One",
    label: "Backup",
    kind: "signed_out",
    summary: "claude-backup is signed out",
    fixCommand: "claude auth login",
    canSignIn: true,
    hostSupportsSignIn: true,
    ...overrides,
  };
}

const seenTops: number[] = [];

function ShellProbe() {
  seenTops.push(useSafeAreaInsets().top);
  return null;
}

let root: Root | null = null;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  useAccountAlertStore.setState({ byHost: {} });
  seenTops.length = 0;
  root = createRoot(dom.window.document.body.appendChild(dom.window.document.createElement("div")));
  act(() => {
    root?.render(
      <SafeAreaInsetsContext.Provider value={DEVICE_INSETS}>
        <BelowBannerInsets>
          <ShellProbe />
        </BelowBannerInsets>
      </SafeAreaInsetsContext.Provider>,
    );
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

describe("BelowBannerInsets", () => {
  it("passes the device's top inset through while no account has a problem", () => {
    expect(seenTops).toEqual([47]);
  });

  it("zeroes the top inset below the banner while it shows, and restores it when it goes", () => {
    act(() => reportHostAccountAlerts("server-1", [entry()]));
    expect(seenTops.at(-1)).toBe(0);

    act(() => reportHostAccountAlerts("server-1", []));
    expect(seenTops.at(-1)).toBe(47);
  });

  it("does not re-render the shell when the entries change but the banner stays up", () => {
    act(() => reportHostAccountAlerts("server-1", [entry()]));
    const rendersWithBanner = seenTops.length;

    act(() => reportHostAccountAlerts("server-1", [entry({ summary: "Still signed out" })]));
    act(() => reportHostAccountAlerts("server-2", [entry({ serverId: "server-2" })]));

    expect(seenTops).toHaveLength(rendersWithBanner);
  });
});
