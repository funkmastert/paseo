import { StyleSheet } from "react-native-unistyles";
import type { TokenUsageDisplayRole } from "./token-usage-model";

export const TOKEN_USAGE_ROLE_LABELS: Record<TokenUsageDisplayRole, string> = {
  leader: "Leader",
  worker: "Worker",
  outside: "Outside Paseo",
};

/**
 * One role-to-color mapping, shared by the model card's legend/segments and the role card's dots
 * so recoloring a role (or adding a fourth) is one edit, not four across two files.
 */
export const roleFillStyles = StyleSheet.create((theme) => ({
  leader: { backgroundColor: theme.colors.palette.blue[500] },
  worker: { backgroundColor: theme.colors.palette.purple[500] },
  outside: { backgroundColor: theme.colors.palette.green[500] },
}));
