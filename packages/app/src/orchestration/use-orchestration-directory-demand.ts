import { useEffect } from "react";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

/**
 * Keeps the daemon's agent-directory subscription alive for as long as the orchestration panel
 * is the visible panel in its pane.
 *
 * The panel reads the session store, which is only live because some surface asked the daemon to
 * stream `agent_update`. That ask is the directory *demand* — and every existing holder of it is
 * a different screen: the left sidebar (only while its panel is open), the command palette (only
 * while open), the projects and schedules screens. A workspace with the sidebar closed holds no
 * demand at all.
 *
 * While a socket stays up that costs nothing, because the daemon keeps the subscription it was
 * given. It bites on reconnect: the directory sync re-subscribes on a new connection only
 * `if (this.hasDemand())`, and with no holder the new daemon session has no agent subscription,
 * so `forwardLiveAgent` drops every update on the floor. The panel then renders its last
 * pre-disconnect snapshot, indefinitely and silently — every status frozen at the moment the
 * connection dropped. A fleet monitor cannot depend on another screen being open to stay true,
 * so it holds its own demand.
 *
 * Acquiring also triggers a full refresh when it is the first holder, which is what re-syncs the
 * tree after a reconnect.
 */
export function useOrchestrationDirectoryDemand(serverId: string): void {
  const isActive = useRetainedPanelActive();
  useEffect(() => {
    if (!isActive || !serverId) return undefined;
    return getHostRuntimeStore().acquireDirectoryDemand(serverId);
  }, [isActive, serverId]);
}
