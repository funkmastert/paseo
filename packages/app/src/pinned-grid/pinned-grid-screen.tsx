import { useIsFocused } from "@react-navigation/native";
import { router } from "expo-router";
import { X } from "lucide-react-native";
import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { SidebarModelProvider, useSidebarModel } from "@/components/sidebar/sidebar-model";
import { resolveSidebarWorkspacePrimaryLabel } from "@/components/sidebar/sidebar-workspace-title";
import { Button } from "@/components/ui/button";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { paneContentToolbarIconSize, ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { ScrollView } from "@/components/ui/scroll-view";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useAppSettings } from "@/hooks/use-settings";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { PinnedGridCell } from "@/pinned-grid/pinned-grid-cell";
import { resolvePinnedGridMetrics } from "@/pinned-grid/pinned-grid-layout";
import { PinnedGridStatusDot } from "@/pinned-grid/pinned-grid-status-dot";
import { navigateToLastWorkspace } from "@/stores/navigation-active-workspace-store";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { buildOpenProjectRoute } from "@/utils/host-routes";

const ThemedX = withUnistyles(X);

export function PinnedGridScreen(): ReactElement {
  const isFocused = useIsFocused();
  if (!isFocused) {
    return <View style={styles.container} />;
  }
  // The screen is a route, outside the sidebar's provider. It builds the same model from the same
  // stores, so the grid shows exactly what the Pinned section lists.
  return (
    <SidebarModelProvider active>
      <PinnedGridContent />
    </SidebarModelProvider>
  );
}

function PinnedGridContent(): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const { pinnedGroups, workspaceEntriesByKey } = useSidebarModel();
  const [focusedKey, setFocusedKey] = useState<string | null>(null);

  const entries = useMemo(
    () =>
      pinnedGroups.pinnedChats.flatMap((placement) => {
        const entry = workspaceEntriesByKey.get(placement.workspaceKey);
        return entry ? [entry] : [];
      }),
    [pinnedGroups.pinnedChats, workspaceEntriesByKey],
  );

  // Leaving returns to the route the grid was opened from. A cold load straight onto the grid has
  // nothing behind it, so it falls back to the last workspace, then to the project picker.
  const handleClose = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    if (!navigateToLastWorkspace()) {
      router.navigate(buildOpenProjectRoute());
    }
  }, []);

  const closeButton = useMemo(
    () => (
      <ToolbarButton
        compact={isCompact}
        label={t("pinnedGrid.close")}
        onPress={handleClose}
        testID="pinned-grid-close"
        tooltipSide="left"
      >
        <ThemedX
          size={paneContentToolbarIconSize(isCompact)}
          strokeWidth={1.5}
          uniProps={mutedIconColorMapping}
        />
      </ToolbarButton>
    ),
    [handleClose, isCompact, t],
  );

  let body: ReactElement;
  if (entries.length === 0) {
    body = (
      <View style={styles.empty} testID="pinned-grid-empty">
        <Text style={styles.emptyText}>{t("pinnedGrid.empty")}</Text>
        <Button variant="ghost" onPress={handleClose}>
          {t("pinnedGrid.close")}
        </Button>
      </View>
    );
  } else if (isCompact) {
    body = <PinnedGridPager entries={entries} focusedKey={focusedKey} onFocus={setFocusedKey} />;
  } else {
    body = <PinnedGridTiles entries={entries} focusedKey={focusedKey} onFocus={setFocusedKey} />;
  }

  return (
    <View style={styles.container} testID="pinned-grid-screen">
      <MenuHeader
        title={t("pinnedGrid.title", { count: entries.length })}
        rightContent={closeButton}
      />
      {body}
    </View>
  );
}

interface PinnedGridBodyProps {
  entries: SidebarWorkspaceEntry[];
  focusedKey: string | null;
  onFocus: (workspaceKey: string) => void;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }
  return rows;
}

/**
 * Wide layout: every pinned chat at once. Columns follow the window width; rows share the height
 * until that would squash a cell, and then the grid scrolls at the minimum cell height.
 */
function PinnedGridTiles({ entries, focusedKey, onFocus }: PinnedGridBodyProps): ReactElement {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((previous) =>
      previous && previous.width === width && previous.height === height
        ? previous
        : { width, height },
    );
  }, []);
  const metrics = size ? resolvePinnedGridMetrics({ ...size, count: entries.length }) : null;

  let grid: ReactElement | null = null;
  if (metrics) {
    const rows = chunk(entries, metrics.columns).map((row) => (
      <PinnedGridRow
        key={row[0]?.workspaceKey}
        row={row}
        columns={metrics.columns}
        height={metrics.cellHeight}
        focusedKey={focusedKey}
        onFocus={onFocus}
      />
    ));
    grid = metrics.scrolls ? (
      <ScrollView style={styles.tilesScroll} testID="pinned-grid-scroll">
        <View style={styles.tiles}>{rows}</View>
      </ScrollView>
    ) : (
      <View style={styles.tiles}>{rows}</View>
    );
  }

  return (
    <View style={styles.tilesHost} onLayout={handleLayout} testID="pinned-grid-tiles">
      {grid}
    </View>
  );
}

const PinnedGridRow = memo(function PinnedGridRow({
  row,
  columns,
  height,
  focusedKey,
  onFocus,
}: {
  row: SidebarWorkspaceEntry[];
  columns: number;
  height: number;
  focusedKey: string | null;
  onFocus: (workspaceKey: string) => void;
}) {
  // A short last row keeps the column width of the rows above it.
  const spacers = Array.from({ length: columns - row.length }, (_, index) => index);
  return (
    <View style={[styles.row, inlineUnistylesStyle({ height })]}>
      {row.map((entry) => (
        <View key={entry.workspaceKey} style={styles.slot}>
          <PinnedGridCell
            workspace={entry}
            focused={focusedKey === entry.workspaceKey}
            onFocus={onFocus}
          />
        </View>
      ))}
      {spacers.map((index) => (
        <View key={`spacer-${index}`} style={styles.slot} />
      ))}
    </View>
  );
});

/**
 * Compact layout. A phone cannot tile more than one usable chat, so this is a strip of the pinned
 * chats with live status and one full-size chat under it. Only the selected chat is mounted; the
 * strip's dots keep reporting the others.
 */
function PinnedGridPager({ entries, focusedKey, onFocus }: PinnedGridBodyProps): ReactElement {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = entries.find((entry) => entry.workspaceKey === selectedKey) ?? entries[0];
  const handleSelect = useCallback(
    (workspaceKey: string) => {
      setSelectedKey(workspaceKey);
      onFocus(workspaceKey);
    },
    [onFocus],
  );

  return (
    <View style={styles.pager} testID="pinned-grid-pager">
      <View style={styles.chipStrip}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipStripContent}
        >
          {entries.map((entry) => (
            <PinnedGridChip
              key={entry.workspaceKey}
              entry={entry}
              selected={entry.workspaceKey === selected?.workspaceKey}
              onSelect={handleSelect}
            />
          ))}
        </ScrollView>
      </View>
      {selected ? (
        <View style={styles.pagerCell}>
          <PinnedGridCell
            key={selected.workspaceKey}
            workspace={selected}
            focused={focusedKey === selected.workspaceKey}
            onFocus={onFocus}
          />
        </View>
      ) : null}
    </View>
  );
}

const PinnedGridChip = memo(function PinnedGridChip({
  entry,
  selected,
  onSelect,
}: {
  entry: SidebarWorkspaceEntry;
  selected: boolean;
  onSelect: (workspaceKey: string) => void;
}) {
  const {
    settings: { workspaceTitleSource },
  } = useAppSettings();
  const label = resolveSidebarWorkspacePrimaryLabel({ workspace: entry, workspaceTitleSource });
  const handlePress = useCallback(
    () => onSelect(entry.workspaceKey),
    [entry.workspaceKey, onSelect],
  );
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={handlePress}
      style={[styles.chip, selected && styles.chipSelected]}
      testID={`pinned-grid-chip-${entry.workspaceKey}`}
    >
      <PinnedGridStatusDot bucket={entry.statusBucket} />
      <Text style={selected ? styles.chipTextSelected : styles.chipText} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[6],
    padding: theme.spacing[6],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  tilesHost: {
    flex: 1,
    minHeight: 0,
  },
  tilesScroll: {
    flex: 1,
  },
  tiles: {
    padding: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
  },
  slot: {
    flex: 1,
    minWidth: 0,
    padding: theme.spacing[1],
  },
  pager: {
    flex: 1,
    minHeight: 0,
  },
  chipStrip: {
    flexGrow: 0,
    flexShrink: 0,
  },
  chipStripContent: {
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  chip: {
    minHeight: 36,
    maxWidth: 200,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  chipSelected: {
    backgroundColor: theme.colors.surface2,
  },
  chipText: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  chipTextSelected: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  pagerCell: {
    flex: 1,
    minHeight: 0,
    padding: theme.spacing[1],
  },
}));
