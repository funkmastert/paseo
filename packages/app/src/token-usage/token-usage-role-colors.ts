import type { TokenUsageRole } from "./token-usage-model";

export const TOKEN_USAGE_ROLE_LABELS: Record<TokenUsageRole, string> = {
  leader: "Leader",
  worker: "Worker",
  outside: "Outside Paseo",
};
