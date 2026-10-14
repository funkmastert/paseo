import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useStableEvent } from "@/hooks/use-stable-event";
import { createJumpToStartController } from "./jump-to-start-controller";
import type { StreamViewportHandle } from "./strategy";

export function useJumpToStart(input: {
  agentId: string;
  hasOlderHistory: boolean;
  isLoadingOlderHistory: boolean;
  loadOlder: () => boolean | Promise<boolean>;
  viewportRef: RefObject<StreamViewportHandle | null>;
}) {
  const [isJumpingToStart, setIsJumpingToStart] = useState(false);

  // Read by the controller, which polls across React renders rather than closing
  // over values captured at the moment the jump started.
  const hasOlderHistoryRef = useRef(input.hasOlderHistory);
  hasOlderHistoryRef.current = input.hasOlderHistory;
  const isLoadingOlderHistoryRef = useRef(input.isLoadingOlderHistory);
  isLoadingOlderHistoryRef.current = input.isLoadingOlderHistory;
  const loadOlderRef = useRef(input.loadOlder);
  loadOlderRef.current = input.loadOlder;

  const controllerRef = useRef<ReturnType<typeof createJumpToStartController> | null>(null);
  useEffect(() => {
    return () => {
      controllerRef.current?.cancel();
      controllerRef.current = null;
    };
  }, [input.agentId]);

  const getController = useStableEvent(() => {
    if (!controllerRef.current) {
      controllerRef.current = createJumpToStartController({
        hasOlderHistory: () => hasOlderHistoryRef.current,
        isLoadingOlderHistory: () => isLoadingOlderHistoryRef.current,
        loadOlder: () => loadOlderRef.current(),
        scrollToStart: () => input.viewportRef.current?.scrollToStart(),
        requestFrame: requestAnimationFrame,
        cancelFrame: cancelAnimationFrame,
        onSettle: () => setIsJumpingToStart(false),
      });
    }
    return controllerRef.current;
  });

  const jumpToStart = useCallback(() => {
    const controller = getController();
    if (controller.isActive()) {
      return;
    }
    setIsJumpingToStart(true);
    controller.start();
  }, [getController]);

  return { jumpToStart, isJumpingToStart };
}
