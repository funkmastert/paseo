import { useMemo } from "react";
import { useShallow } from "zustand/shallow";
import type { QueryKey } from "@tanstack/react-query";
import type { DeviceStatusEntry, DeviceStatusUpdateMessage } from "@getpaseo/protocol/messages";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useReplicaQuery } from "@/data/query";
import { useMcpStatusActiveServerId } from "@/mcp-status/use-mcp-status";
import { buildDeviceStatusStripModel, type DeviceStatusStripModel } from "./device-status-model";

export type DeviceStatusPayload = DeviceStatusUpdateMessage["payload"];
export type { DeviceStatusEntry };

export function deviceStatusQueryKey(serverId: string | null): QueryKey {
  return ["deviceStatus", serverId ?? ""];
}

export interface UseDeviceStatusResult {
  /** False on a daemon with no device cap (no `server_info.features.deviceLeases`). */
  supportsDeviceStatus: boolean;
  model: DeviceStatusStripModel;
}

/**
 * The device cap's read-only status (docs/device-leases.md), host-scoped to the same active
 * host the MCP status strip resolves. Pure replica: everything comes from the daemon's
 * `device_status_update` push, which counts devices from its process scan — the strip never
 * derives a count of its own.
 */
export function useDeviceStatus(): UseDeviceStatusResult {
  const serverId = useMcpStatusActiveServerId();
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  // COMPAT(deviceLeases): added in v0.8.1, remove gate after 2027-03-18.
  const supportsDeviceStatus = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.deviceLeases === true,
  );

  const statusQuery = useReplicaQuery<DeviceStatusPayload>({
    queryKey: deviceStatusQueryKey(serverId),
    pushEvent: "device_status_update",
    enabled: Boolean(serverId && supportsDeviceStatus && isConnected),
  });

  // Titles for the agents holding devices. The daemon sends ids — it has no business deciding
  // what an agent is called — and the client already has every title in its session store.
  const agentTitles = useSessionStore(
    useShallow((state) => {
      const agents = serverId ? state.sessions[serverId]?.agents : undefined;
      if (!agents) return {};
      const titles: Record<string, string> = {};
      for (const agent of agents.values()) {
        const title = agent.title?.trim();
        if (title) titles[agent.id] = title;
      }
      return titles;
    }),
  );

  const model = useMemo(
    () => buildDeviceStatusStripModel(statusQuery.data, agentTitles),
    [statusQuery.data, agentTitles],
  );

  return { supportsDeviceStatus, model };
}
