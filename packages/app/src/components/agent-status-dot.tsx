import { useMemo } from "react";
import { View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  AGENT_LIFECYCLE_STATUSES,
  type AgentLifecycleStatus,
} from "@getpaseo/protocol/agent-lifecycle";
import { StatusRing } from "@/components/status-ring";
import { deriveSidebarStateBucket, type SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";

/** Whether `AgentStatusDot` draws the running ring instead of its static dot — pure so the
 * leader-vs-tree parity is testable without rendering. True only when the caller opts into
 * `animated`: list surfaces with many rows (command palette search results) keep the static dot
 * rather than pay for a running row's animation on every result. */
export function shouldAnimateAgentStatusDot({
  bucket,
  animated,
}: {
  bucket: SidebarStateBucket;
  animated: boolean;
}): boolean {
  return animated && bucket === "running";
}

export function AgentStatusDot({
  status,
  requiresAttention,
  attentionReason,
  pendingPermissionCount,
  showInactive = false,
  animated = false,
}: {
  status: string | null | undefined;
  requiresAttention: boolean | null | undefined;
  attentionReason?: "finished" | "error" | "permission" | null;
  pendingPermissionCount?: number;
  showInactive?: boolean;
  /** Show the same running ring the leader's workspace row uses instead of a static dot. Off by
   * default: opt in per surface. */
  animated?: boolean;
}) {
  const { theme } = useUnistyles();

  if (!status) {
    return null;
  }
  if (!isAgentLifecycleStatus(status)) {
    return null;
  }

  const bucket = deriveSidebarStateBucket({
    status,
    requiresAttention: Boolean(requiresAttention),
    attentionReason: attentionReason ?? null,
    pendingPermissionCount: pendingPermissionCount ?? 0,
  });

  if (shouldAnimateAgentStatusDot({ bucket, animated })) {
    return <StatusRing />;
  }

  const color = getStatusDotColor({ theme, bucket, showDoneAsInactive: showInactive });

  if (!color) {
    return null;
  }

  return <AgentStatusDotView color={color} />;
}

function AgentStatusDotView({ color }: { color: string }) {
  const dotStyle = useMemo(() => [styles.dot, { backgroundColor: color }], [color]);
  return <View style={dotStyle} />;
}

function isAgentLifecycleStatus(value: string): value is AgentLifecycleStatus {
  return AGENT_LIFECYCLE_STATUSES.some((status) => status === value);
}

const styles = StyleSheet.create((theme) => ({
  dot: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
  },
}));
