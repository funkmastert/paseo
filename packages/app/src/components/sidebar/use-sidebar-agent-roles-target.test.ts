// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSidebarAgentRolesTarget } from "./use-sidebar-agent-roles-target";
import type { InstalledPlugin } from "@/plugins/types";

const HOST_ID = "host-1";

const hooks = vi.hoisted(() => ({
  hosts: [] as { serverId: string }[],
  localServerId: null as string | null,
  connected: false,
  supported: false,
  plugin: null as InstalledPlugin | null,
}));

vi.mock("@/hooks/use-is-local-daemon", () => ({
  useLocalDaemonServerId: () => hooks.localServerId,
}));
vi.mock("@/plugins/registry", () => ({
  useInstalledPlugin: () => hooks.plugin,
}));
vi.mock("@/runtime/host-features", () => ({
  useHostFeature: () => hooks.supported,
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => hooks.hosts,
  useHostRuntimeIsConnected: () => hooks.connected,
}));

function installedPlugin(screens: { id: string; icon: string }[]): InstalledPlugin {
  return {
    serverId: HOST_ID,
    id: "claude-account-pool",
    settingsScreens: screens.map((screen) => ({
      id: screen.id,
      title: "Agent Model Policy",
      icon: screen.icon,
      Component: () => null,
    })),
  } as unknown as InstalledPlugin;
}

function resetHooks(): void {
  hooks.hosts = [];
  hooks.localServerId = null;
  hooks.connected = false;
  hooks.supported = false;
  hooks.plugin = null;
}

describe("useSidebarAgentRolesTarget", () => {
  it("resolves the roles target when the active host is connected, supported, and has the screen", () => {
    resetHooks();
    hooks.hosts = [{ serverId: HOST_ID }];
    hooks.connected = true;
    hooks.supported = true;
    hooks.plugin = installedPlugin([{ id: "agent-model-policy", icon: "Route" }]);

    const { result } = renderHook(() => useSidebarAgentRolesTarget());

    expect(result.current).toEqual({
      serverId: HOST_ID,
      pluginId: "claude-account-pool",
      screenId: "agent-model-policy",
      icon: "Route",
    });
  });

  it("falls back to null when there is no host", () => {
    resetHooks();

    const { result } = renderHook(() => useSidebarAgentRolesTarget());

    expect(result.current).toBeNull();
  });

  it("falls back to null when the host is disconnected", () => {
    resetHooks();
    hooks.hosts = [{ serverId: HOST_ID }];
    hooks.connected = false;
    hooks.supported = true;
    hooks.plugin = installedPlugin([{ id: "agent-model-policy", icon: "Route" }]);

    const { result } = renderHook(() => useSidebarAgentRolesTarget());

    expect(result.current).toBeNull();
  });

  it("falls back to null when the daemon doesn't speak the pluginSettings feature", () => {
    resetHooks();
    hooks.hosts = [{ serverId: HOST_ID }];
    hooks.connected = true;
    hooks.supported = false;
    hooks.plugin = installedPlugin([{ id: "agent-model-policy", icon: "Route" }]);

    const { result } = renderHook(() => useSidebarAgentRolesTarget());

    expect(result.current).toBeNull();
  });

  it("falls back to null when the host doesn't have the claude-account-pool plugin installed", () => {
    resetHooks();
    hooks.hosts = [{ serverId: HOST_ID }];
    hooks.connected = true;
    hooks.supported = true;
    hooks.plugin = null;

    const { result } = renderHook(() => useSidebarAgentRolesTarget());

    expect(result.current).toBeNull();
  });

  it("falls back to null when the plugin is installed but hasn't registered the agent-model-policy screen", () => {
    resetHooks();
    hooks.hosts = [{ serverId: HOST_ID }];
    hooks.connected = true;
    hooks.supported = true;
    hooks.plugin = installedPlugin([{ id: "some-other-screen", icon: "Route" }]);

    const { result } = renderHook(() => useSidebarAgentRolesTarget());

    expect(result.current).toBeNull();
  });
});
