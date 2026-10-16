/**
 * Push-notification shape for a spent JEV lane budget (docs/jev.md, "A spent budget is visible").
 * `data.reason` is untyped JSON on the wire, like the token-burn reasons, so an old app that does
 * not know it falls back to opening the server by `serverId`.
 */
export interface JevBudgetExhaustedNotificationData {
  [key: string]: unknown;
  serverId: string;
  reason: "jev_budget_exhausted";
  lane: string;
}

export interface JevBudgetExhaustedNotificationPayload {
  title: string;
  body: string;
  data: JevBudgetExhaustedNotificationData;
}

interface BuildJevBudgetExhaustedNotificationPayloadInput {
  serverId: string;
  lane: string;
  laneLabel: string;
  topFeature: string | null;
  resetsAtLocal: string;
}

/** Hardcoded English, like the other server-built pushes: it never crosses the app i18n pipeline. */
export function buildJevBudgetExhaustedNotificationPayload(
  input: BuildJevBudgetExhaustedNotificationPayloadInput,
): JevBudgetExhaustedNotificationPayload {
  const spentOn = input.topFeature ? `, mostly on ${input.topFeature}` : "";
  return {
    title: "JEV budget spent",
    body: `The ${input.laneLabel} lane hit its daily budget${spentOn}. Resets at ${input.resetsAtLocal}.`,
    data: {
      serverId: input.serverId,
      reason: "jev_budget_exhausted",
      lane: input.lane,
    },
  };
}
