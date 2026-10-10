import { useEffect, useRef, useState } from "react";
import {
  resolveOrchestrationFreshness,
  type OrchestrationFreshness,
} from "@/orchestration/orchestration-panel-model";
import {
  useHostRuntimeAgentDirectoryStatus,
  useHostRuntimeConnectionStatus,
} from "@/runtime/host-runtime";

export interface OrchestrationFreshnessState {
  freshness: OrchestrationFreshness;
  /**
   * When the tree stopped being live, or null if it has been live the whole time this panel has
   * been open — a cold start against an unreachable host has cached rows and no honest
   * timestamp to put on them.
   */
  liveUntil: Date | null;
}

export function useOrchestrationFreshness(serverId: string): OrchestrationFreshnessState {
  const connectionStatus = useHostRuntimeConnectionStatus(serverId);
  const directoryStatus = useHostRuntimeAgentDirectoryStatus(serverId);
  const freshness = resolveOrchestrationFreshness({ connectionStatus, directoryStatus });

  // Stamped on the way out of live, not on every live render: the value the user needs is "these
  // rows stopped moving at X", which is only knowable at the transition.
  const [liveUntil, setLiveUntil] = useState<Date | null>(null);
  const wasLiveRef = useRef(false);
  const isLive = freshness.kind === "live";
  useEffect(() => {
    if (isLive) {
      wasLiveRef.current = true;
      return;
    }
    if (!wasLiveRef.current) return;
    wasLiveRef.current = false;
    setLiveUntil(new Date());
  }, [isLive]);

  return { freshness, liveUntil };
}
