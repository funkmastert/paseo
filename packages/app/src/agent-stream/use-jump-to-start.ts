import { useCallback, useRef, useState, type RefObject } from "react";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { planTimelineStartFetch } from "@/timeline/timeline-sync-plan";
import { jumpToTimelineStart } from "./timeline-start-navigation";
import type { StreamViewportHandle } from "./strategy";

export function useJumpToStart(input: {
  agentId: string;
  serverId: string;
  hasRemoteOlderHistory: boolean;
  revealLoadedHistory: (itemId?: string) => boolean;
  viewportRef: RefObject<StreamViewportHandle | null>;
  onError: () => void;
}) {
  const [isJumpingToStart, setIsJumpingToStart] = useState(false);
  const pendingRef = useRef(false);

  // Read by the jump once it resolves, rather than closed over at the moment
  // the user pressed the button.
  const hasRemoteOlderHistoryRef = useRef(input.hasRemoteOlderHistory);
  hasRemoteOlderHistoryRef.current = input.hasRemoteOlderHistory;
  const revealLoadedHistoryRef = useRef(input.revealLoadedHistory);
  revealLoadedHistoryRef.current = input.revealLoadedHistory;
  const onErrorRef = useRef(input.onError);
  onErrorRef.current = input.onError;

  const jumpToStart = useCallback(() => {
    if (pendingRef.current) {
      return;
    }
    pendingRef.current = true;
    setIsJumpingToStart(true);
    void jumpToTimelineStart({
      needsFetch: hasRemoteOlderHistoryRef.current,
      fetchStart: () =>
        getHostRuntimeStore().fetchAgentTimeline(
          input.serverId,
          input.agentId,
          planTimelineStartFetch(),
        ),
      revealEarliest: () => {
        const earliestItem = useSessionStore
          .getState()
          .sessions[input.serverId]?.agentStreamTail.get(input.agentId)?.[0];
        if (!earliestItem) {
          return null;
        }
        revealLoadedHistoryRef.current(earliestItem.id);
        return earliestItem.id;
      },
      // One frame so the reveal's state update commits -- the strategies' own
      // scrollToMessage settle controller then retries if the row still isn't
      // mounted after that.
      scrollToStart: (itemId) => {
        requestAnimationFrame(() => {
          input.viewportRef.current?.scrollToStart(itemId);
        });
      },
      onError: () => onErrorRef.current(),
    }).finally(() => {
      pendingRef.current = false;
      setIsJumpingToStart(false);
    });
  }, [input.agentId, input.serverId, input.viewportRef]);

  return { jumpToStart, isJumpingToStart };
}
