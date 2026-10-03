import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { StatusRing } from "@/components/status-ring";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { getStatusDotColor } from "@/utils/status-dot-color";

/** A workspace's live state as the sidebar row reports it: the ring while it runs, a dot otherwise. */
export function PinnedGridStatusDot({ bucket }: { bucket: SidebarStateBucket }) {
  if (bucket === "running") {
    return (
      <View style={styles.slot} testID="pinned-grid-status-running">
        <StatusRing />
      </View>
    );
  }
  return (
    <View style={styles.slot} testID={`pinned-grid-status-${bucket}`}>
      <View style={styles.dot({ bucket })} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  slot: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  dot: ({ bucket }: { bucket: SidebarStateBucket }) => ({
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor:
      getStatusDotColor({ theme, bucket, showDoneAsInactive: true }) ?? theme.colors.border,
  }),
}));
