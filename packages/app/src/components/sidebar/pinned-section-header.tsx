import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, LayoutGrid } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { paneContentToolbarIconSize, ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedLayoutGrid = withUnistyles(LayoutGrid);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export function PinnedSectionHeader({
  collapsed,
  onToggle,
  onOpenGrid,
}: {
  collapsed: boolean;
  onToggle: () => void;
  onOpenGrid: () => void;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  const Chevron = collapsed ? ThemedChevronRight : ThemedChevronDown;

  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        onPress={onToggle}
        style={styles.header}
        testID="sidebar-pinned-section-header"
      >
        {({ hovered }) => (
          <>
            <Text style={styles.title}>{t("sidebar.pinned.title")}</Text>
            {hovered || isNative || isCompact ? (
              <Chevron size={12} uniProps={foregroundMutedColorMapping} />
            ) : null}
          </>
        )}
      </Pressable>
      {/* A sibling of the toggle, not a child: hover and press stay on separate elements. */}
      <ToolbarButton
        compact={isCompact}
        label={t("sidebar.pinned.openGrid")}
        onPress={onOpenGrid}
        testID="sidebar-pinned-open-grid"
        tooltipSide="right"
      >
        <ThemedLayoutGrid
          size={paneContentToolbarIconSize(isCompact)}
          strokeWidth={1.5}
          uniProps={mutedIconColorMapping}
        />
      </ToolbarButton>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    // Keeps the grid button's glyph on the same right rail as the row kebabs below.
    paddingRight: theme.spacing[2],
  },
  header: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    userSelect: "none",
  },
  title: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
}));
