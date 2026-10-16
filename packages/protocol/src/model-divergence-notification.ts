/**
 * Push-notification shape for the model-divergence monitor. `data.reason` is untyped JSON on the
 * wire, like the token-burn reasons, so an old app that does not know it opens the agent by
 * `agentId`.
 */
export interface ModelDivergenceNotificationData {
  [key: string]: unknown;
  serverId: string;
  workspaceId?: string;
  agentId: string;
  reason: "model_divergence";
}

export interface ModelDivergenceNotificationPayload {
  title: string;
  body: string;
  data: ModelDivergenceNotificationData;
}

interface BuildModelDivergenceNotificationPayloadInput {
  serverId: string;
  workspaceId?: string;
  agentId: string;
  agentTitle?: string | null;
  configuredModel: string;
  observedModel: string;
  responses: number;
}

/** Hardcoded English, like the other server-built pushes: it never crosses the app i18n pipeline. */
export function buildModelDivergenceNotificationPayload(
  input: BuildModelDivergenceNotificationPayloadInput,
): ModelDivergenceNotificationPayload {
  const label = input.agentTitle?.trim() || "An agent";
  return {
    title: "Agent is running a different model",
    body:
      `${label} was set to ${input.configuredModel} but its last ${input.responses} responses ` +
      `came from ${input.observedModel}.`,
    data: {
      serverId: input.serverId,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      agentId: input.agentId,
      reason: "model_divergence",
    },
  };
}
