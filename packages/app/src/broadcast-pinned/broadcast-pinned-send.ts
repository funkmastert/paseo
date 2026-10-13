import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages";
import {
  dispatchComposerAgentMessage,
  type ComposerSendClient,
  type MessageSubmissionWriter,
} from "@/composer/actions";
import type { BroadcastPinnedTarget } from "./broadcast-pinned-targets";

export interface BroadcastSendFailure {
  target: BroadcastPinnedTarget;
  error: string;
}

export interface BroadcastSendResult {
  succeeded: string[];
  failed: BroadcastSendFailure[];
}

export interface SendBroadcastPinnedPromptInput {
  targets: readonly BroadcastPinnedTarget[];
  text: string;
  getClient: (serverId: string) => ComposerSendClient | null;
  resolveActiveTurn: (target: BroadcastPinnedTarget) => {
    behavior: ActiveTurnBehavior;
    turnId?: string;
  };
  makeSubmission: (serverId: string) => MessageSubmissionWriter;
}

/**
 * Sends one prompt to every target agent, through the same path the ordinary composer uses
 * (`dispatchComposerAgentMessage`) — one request per agent, in parallel, so a running agent gets
 * its configured queue/steer/interrupt behavior exactly as if the text had been typed into its
 * own composer. `Promise.allSettled` means one target's failure never cancels the others.
 */
export async function sendBroadcastPinnedPrompt(
  input: SendBroadcastPinnedPromptInput,
): Promise<BroadcastSendResult> {
  const { targets, text, getClient, resolveActiveTurn, makeSubmission } = input;
  if (targets.length === 0) {
    return { succeeded: [], failed: [] };
  }

  const outcomes = await Promise.allSettled(
    targets.map(async (target) => {
      const client = getClient(target.serverId);
      if (!client) {
        throw new Error("Host disconnected.");
      }
      const { behavior, turnId } = resolveActiveTurn(target);
      await dispatchComposerAgentMessage({
        client,
        agentId: target.id,
        text,
        attachments: [],
        encodeImages: async () => [],
        submission: makeSubmission(target.serverId),
        activeTurnBehavior: behavior,
        activeTurnId: turnId,
      });
      return target.id;
    }),
  );

  const succeeded: string[] = [];
  const failed: BroadcastSendFailure[] = [];
  outcomes.forEach((outcome, index) => {
    const target = targets[index];
    if (!target) return;
    if (outcome.status === "fulfilled") {
      succeeded.push(outcome.value);
    } else {
      const reason = outcome.reason;
      failed.push({ target, error: reason instanceof Error ? reason.message : String(reason) });
    }
  });
  return { succeeded, failed };
}
