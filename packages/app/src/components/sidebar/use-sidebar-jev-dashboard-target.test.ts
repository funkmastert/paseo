// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSidebarJevDashboardTarget } from "./use-sidebar-jev-dashboard-target";

const HOST_ID = "host-1";

const hooks = vi.hoisted(() => ({
  hosts: [] as { serverId: string }[],
  localServerId: null as string | null,
  connected: false,
  supported: false,
}));

vi.mock("@/hooks/use-is-local-daemon", () => ({
  useLocalDaemonServerId: () => hooks.localServerId,
}));
vi.mock("@/runtime/host-features", () => ({
  useHostFeature: () => hooks.supported,
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => hooks.hosts,
  useHostRuntimeIsConnected: () => hooks.connected,
}));

function resetHooks(): void {
  hooks.hosts = [];
  hooks.localServerId = null;
  hooks.connected = false;
  hooks.supported = false;
}

describe("useSidebarJevDashboardTarget", () => {
  it("resolves the active host when it is connected and speaks jevSavings", () => {
    resetHooks();
    hooks.hosts = [{ serverId: HOST_ID }];
    hooks.connected = true;
    hooks.supported = true;

    const { result } = renderHook(() => useSidebarJevDashboardTarget());

    expect(result.current).toEqual({ serverId: HOST_ID });
  });

  it("falls back to null when there is no host", () => {
    resetHooks();

    const { result } = renderHook(() => useSidebarJevDashboardTarget());

    expect(result.current).toBeNull();
  });

  it("falls back to null when the host is disconnected", () => {
    resetHooks();
    hooks.hosts = [{ serverId: HOST_ID }];
    hooks.connected = false;
    hooks.supported = true;

    const { result } = renderHook(() => useSidebarJevDashboardTarget());

    expect(result.current).toBeNull();
  });

  it("falls back to null when the daemon doesn't speak the jevSavings feature", () => {
    resetHooks();
    hooks.hosts = [{ serverId: HOST_ID }];
    hooks.connected = true;
    hooks.supported = false;

    const { result } = renderHook(() => useSidebarJevDashboardTarget());

    expect(result.current).toBeNull();
  });
});
