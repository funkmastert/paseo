import type { TokenUsageDisplayRole } from "./token-usage-model";

export const TOKEN_USAGE_ROLE_LABELS: Record<TokenUsageDisplayRole, string> = {
  leader: "Leader",
  worker: "Worker",
  outside: "Outside Paseo",
};
