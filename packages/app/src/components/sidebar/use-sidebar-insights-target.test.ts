// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSidebarInsightsTarget } from "./use-sidebar-insights-target";

const HOST_ID = "host-1";

const hooks = vi.hoisted(() => ({
  activeServerId: null as string | null,
  connected: false,
  supported: false,
}));

vi.mock("@/hooks/use-active-host-server-id", () => ({
  useActiveHostServerId: () => hooks.activeServerId,
}));
vi.mock("@/runtime/host-features", () => ({
  useHostFeature: () => hooks.supported,
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeIsConnected: () => hooks.connected,
}));

function resetHooks(): void {
  hooks.activeServerId = null;
  hooks.connected = false;
  hooks.supported = false;
}

describe("useSidebarInsightsTarget", () => {
  it("resolves the active host when it is connected and speaks compactionLedger", () => {
    resetHooks();
    hooks.activeServerId = HOST_ID;
    hooks.connected = true;
    hooks.supported = true;

    const { result } = renderHook(() => useSidebarInsightsTarget());

    expect(result.current).toEqual({ serverId: HOST_ID });
  });

  it("falls back to null when there is no host", () => {
    resetHooks();

    const { result } = renderHook(() => useSidebarInsightsTarget());

    expect(result.current).toBeNull();
  });

  it("falls back to null when the host is disconnected", () => {
    resetHooks();
    hooks.activeServerId = HOST_ID;
    hooks.connected = false;
    hooks.supported = true;

    const { result } = renderHook(() => useSidebarInsightsTarget());

    expect(result.current).toBeNull();
  });

  it("falls back to null when the daemon doesn't speak the compactionLedger feature", () => {
    resetHooks();
    hooks.activeServerId = HOST_ID;
    hooks.connected = true;
    hooks.supported = false;

    const { result } = renderHook(() => useSidebarInsightsTarget());

    expect(result.current).toBeNull();
  });
});
