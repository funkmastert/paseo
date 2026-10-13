import { useCallback } from "react";
import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages";
import { queueComposerMessage } from "@/composer/actions";
import { toActiveTurnBehavior, type SendBehavior } from "@/composer/input/state";
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

export type BroadcastTargetSendPlan =
  | { queueLocally: true }
  | { queueLocally: false; behavior: ActiveTurnBehavior; turnId?: string };

/**
 * Per-target send plan, mirroring `runDefaultSendAction` in the ordinary composer: a target whose
 * send behavior is "queue" and that is mid-turn queues client-side instead of dispatching; every
 * other target dispatches with the behavior/turnId the running composer would use.
 */
export function resolveBroadcastTargetSendPlan(input: {
  sendBehavior: SendBehavior;
  isRunning: boolean;
  turnId: string | null;
}): BroadcastTargetSendPlan {
  if (input.sendBehavior === "queue" && input.isRunning) {
    return { queueLocally: true };
  }
  const behavior = toActiveTurnBehavior(input.sendBehavior);
  if (behavior !== "steer") {
    return { queueLocally: false, behavior };
  }
  return { queueLocally: false, behavior, turnId: input.turnId ?? undefined };
}

/**
 * Targets plus a ready-to-call send handler for the sidebar's broadcast-to-pinned-leaders
 * button. Shared by every sidebar surface that renders `PinnedSectionHeader` so the
 * active-turn/submission wiring lives in one place. A target whose send behavior is "queue" and
 * that is currently mid-turn queues client-side instead of dispatching — see
 * `resolveBroadcastTargetSendPlan`.
 */
export function useBroadcastPinnedComposer(): BroadcastPinnedComposer {
  const { targets } = useBroadcastPinnedTargets();
  const { settings: appSettings } = useAppSettings();

  const onSend = useCallback(
    (text: string, targetIds: string[]) => {
      const idSet = new Set(targetIds);
      const selected = targets.filter((target) => idSet.has(target.id));
      const plans = new Map(
        selected.map((target) => {
          const presentation = selectAgentTurnPresentation(
            useSessionStore.getState().sessions[target.serverId],
            target.id,
          );
          return [
            target.id,
            resolveBroadcastTargetSendPlan({
              sendBehavior: appSettings.sendBehavior,
              isRunning: presentation.isActive,
              turnId: presentation.turnId,
            }),
          ] as const;
        }),
      );

      return sendBroadcastPinnedPrompt({
        targets: selected,
        text,
        getClient: (serverId) => getHostRuntimeStore().getClient(serverId),
        makeSubmission: (serverId) => createMessageSubmissionWriter(serverId),
        shouldQueueLocally: (target) => plans.get(target.id)?.queueLocally === true,
        queueLocally: (target) => {
          queueComposerMessage({
            agentId: target.id,
            text,
            attachments: [],
            queue: {
              read: (id) =>
                useSessionStore.getState().sessions[target.serverId]?.queuedMessages?.get(id) ?? [],
              write: (updater) =>
                useSessionStore.getState().setQueuedMessages(target.serverId, updater),
            },
          });
        },
        resolveActiveTurn: (target) => {
          const plan = plans.get(target.id);
          if (!plan || plan.queueLocally) {
            return { behavior: "steer" };
          }
          return { behavior: plan.behavior, turnId: plan.turnId };
        },
      });
    },
    [appSettings.sendBehavior, targets],
  );

  return { targets, onSend };
}
