import { useCallback } from "react";
import { toActiveTurnBehavior } from "@/composer/input/state";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import { useAppSettings } from "@/hooks/use-settings";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { selectAgentTurnPresentation, useSessionStore } from "@/stores/session-store";
import { sendBroadcastPinnedPrompt, type BroadcastSendResult } from "./broadcast-pinned-send";
import { useBroadcastPinnedTargets } from "./use-broadcast-pinned-targets";
import type { BroadcastPinnedTarget } from "./broadcast-pinned-targets";

export interface BroadcastPinnedComposer {
  targets: BroadcastPinnedTarget[];
  onSend: (text: string, targetIds: string[]) => Promise<BroadcastSendResult>;
}

/**
 * Targets plus a ready-to-call send handler for the sidebar's broadcast-to-pinned-leaders
 * button. Shared by every sidebar surface that renders `PinnedSectionHeader` so the
 * active-turn/submission wiring lives in one place.
 */
export function useBroadcastPinnedComposer(): BroadcastPinnedComposer {
  const { targets } = useBroadcastPinnedTargets();
  const { settings: appSettings } = useAppSettings();

  const onSend = useCallback(
    (text: string, targetIds: string[]) => {
      const idSet = new Set(targetIds);
      const selected = targets.filter((target) => idSet.has(target.id));
      return sendBroadcastPinnedPrompt({
        targets: selected,
        text,
        getClient: (serverId) => getHostRuntimeStore().getClient(serverId),
        makeSubmission: (serverId) => createMessageSubmissionWriter(serverId),
        resolveActiveTurn: (target) => {
          const behavior = toActiveTurnBehavior(appSettings.sendBehavior);
          if (behavior !== "steer") {
            return { behavior };
          }
          const turnId =
            selectAgentTurnPresentation(
              useSessionStore.getState().sessions[target.serverId],
              target.id,
            ).turnId ?? undefined;
          return { behavior, turnId };
        },
      });
    },
    [appSettings.sendBehavior, targets],
  );

  return { targets, onSend };
}
