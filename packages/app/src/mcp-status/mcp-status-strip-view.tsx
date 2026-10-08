import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View, type LayoutChangeEvent } from "react-native";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  EyeOff,
  KeyRound,
  Server,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ProviderUsageTone } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { buttonControlHeight, createControlGeometry } from "@/components/ui/control-geometry";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { Theme } from "@/styles/theme";
import {
  actionLabelText,
  compactStatusText,
  headlineText,
  remedyLines,
  secondLineText,
} from "./mcp-status-copy";
import type {
  McpStatusActionFailure,
  McpStatusRow,
  McpStatusStripModel,
} from "./mcp-status-strip-model";

const ThemedServer = withUnistyles(Server);
const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedEyeOff = withUnistyles(EyeOff);

const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const CHEVRON_SIZE = 14;
// The xs button's own icon size, so the chevron matches the label beside it.
const DISCLOSURE_CHEVRON_SIZE = 12;
const MENU_ICON_SIZE = 14;
const DOT_SIZE = 6;
const SECOND_LINE_CLAMP = 2;
// Tied to the font, like orchestration-row.tsx's title, so a larger Interface size grows the line
// box instead of clipping it.
const LINE_HEIGHT_RATIO = 1.4;

function toneDotStyle(tone: ProviderUsageTone) {
  switch (tone) {
    case "ok":
      return styles.dotOk;
    case "warning":
      return styles.dotWarning;
    case "danger":
      return styles.dotDanger;
    default:
      return styles.dotDefault;
  }
}

function StatusDot({
  tone,
  testID,
  tall = false,
}: {
  tone: ProviderUsageTone;
  testID?: string;
  /** On a problem row, whose first line is as tall as its button. */
  tall?: boolean;
}) {
  return (
    <View style={tall ? styles.issueDotSlot : styles.dotSlot}>
      <View testID={testID} style={[styles.dot, toneDotStyle(tone)]} />
    </View>
  );
}

/** A row's single trailing control: the action, or Hide when there is none. */
function IssueRowTrailing({
  row,
  actionPending,
  onAction,
  onHide,
}: {
  row: McpStatusRow;
  /** This row's own sign-in or broker request is in flight. */
  actionPending: boolean;
  onAction: (row: McpStatusRow) => void;
  onHide: (name: string) => void;
}) {
  const { t } = useTranslation();
  const handleAction = useCallback(() => onAction(row), [onAction, row]);
  const handleHide = useCallback(() => onHide(row.name), [onHide, row.name]);

  if (!row.action) {
    return (
      <Button
        variant="ghost"
        size="xs"
        onPress={handleHide}
        style={styles.ghostOnRail}
        testID={`mcp-status-hide-${row.name}`}
      >
        {t("mcpStatus.hideAction")}
      </Button>
    );
  }
  return (
    <Button
      variant="outline"
      size="xs"
      leftIcon={row.action === "openClaudeAi" ? ExternalLink : KeyRound}
      onPress={handleAction}
      loading={actionPending}
      testID={`mcp-status-auth-${row.name}`}
    >
      {actionLabelText(t, row)}
    </Button>
  );
}

/** What expanding a failure shows under its sentence: the host facts to act on, then Copy. */
function FailureDetails({ row, failure }: { row: McpStatusRow; failure: McpStatusActionFailure }) {
  const { t } = useTranslation();
  return (
    <View style={styles.failureDetails}>
      {remedyLines(t, row, failure).map((line) => (
        <View key={line.key} style={styles.remedyLine}>
          <Text style={styles.remedyLabel}>{line.label}</Text>
          <Text
            style={styles.remedyValue}
            selectable
            testID={`mcp-status-remedy-${line.key}-${row.name}`}
          >
            {line.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * An unhealthy row. The one trailing control shares only the name's line, so everything under the
 * name runs the full width from the name's rail to the strip's trailing rail. The dot centres on
 * that first line, not on the whole block.
 *
 * The second line is the failure when there is one, otherwise the status, clamped to two lines.
 * Whether the clamp cut anything is measured rather than guessed — an invisible unclamped copy
 * lays out at the same width — because `onTextLayout` would answer on native only. "More" shows
 * when something is cut or the failure carries host facts; expanded adds those facts and Copy,
 * because nobody retypes a callback URL from a sidebar.
 */
function IssueRow({
  row,
  actionPending,
  onAction,
  onHide,
  onCopyFailure,
}: {
  row: McpStatusRow;
  actionPending: boolean;
  onAction: (row: McpStatusRow) => void;
  onHide: (name: string) => void;
  onCopyFailure: (row: McpStatusRow, failure: McpStatusActionFailure) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [clampedHeight, setClampedHeight] = useState(0);
  const [fullHeight, setFullHeight] = useState(0);

  const secondLine = secondLineText(t, row);
  const { failure } = row;
  const hasRemedy = failure ? remedyLines(t, row, failure).length > 0 : false;
  // A pixel of slack: the two layouts round independently on web.
  const isClamped = fullHeight > clampedHeight + 1;
  const canExpand = isClamped || hasRemedy;

  const handleToggle = useCallback(() => setExpanded((previous) => !previous), []);
  const handleHide = useCallback(() => onHide(row.name), [onHide, row.name]);
  const handleCopy = useCallback(() => {
    if (failure) onCopyFailure(row, failure);
  }, [failure, onCopyFailure, row]);
  const handleClampedLayout = useCallback(
    (event: LayoutChangeEvent) => setClampedHeight(event.nativeEvent.layout.height),
    [],
  );
  const handleFullLayout = useCallback(
    (event: LayoutChangeEvent) => setFullHeight(event.nativeEvent.layout.height),
    [],
  );
  // Built here rather than at module scope: the classic JSX runtime needs React on the global,
  // and the browser capture only stubs it once a test is running.
  const hideIcon = useMemo(
    () => <ThemedEyeOff size={MENU_ICON_SIZE} uniProps={foregroundMutedColorMapping} />,
    [],
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger style={styles.issueRow} testID={`mcp-status-row-${row.name}`}>
        <StatusDot tone={row.tone} testID={`mcp-status-dot-${row.name}`} tall />
        <View style={styles.issueBody}>
          <View style={styles.issueHead}>
            <Text style={styles.name} numberOfLines={1} testID={`mcp-status-name-${row.name}`}>
              {row.name}
            </Text>
            <IssueRowTrailing
              row={row}
              actionPending={actionPending}
              onAction={onAction}
              onHide={onHide}
            />
          </View>
          <View style={styles.secondLineBlock}>
            <Text
              style={styles.secondLine}
              numberOfLines={expanded ? undefined : SECOND_LINE_CLAMP}
              selectable={expanded}
              onLayout={handleClampedLayout}
              testID={`mcp-status-second-line-${row.name}`}
            >
              {secondLine}
            </Text>
            {expanded ? null : (
              <View
                style={styles.measureCopy}
                pointerEvents="none"
                accessible={false}
                aria-hidden
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                onLayout={handleFullLayout}
              >
                <Text style={styles.secondLine}>{secondLine}</Text>
              </View>
            )}
          </View>
          {expanded && failure ? <FailureDetails row={row} failure={failure} /> : null}
          {canExpand || expanded ? (
            <View style={styles.disclosureLine}>
              <Button
                variant="ghost"
                size="xs"
                onPress={handleToggle}
                accessibilityLabel={t(
                  expanded ? "mcpStatus.showLessError" : "mcpStatus.showFullError",
                )}
                style={styles.ghostOnNameRail}
                testID={`mcp-status-more-${row.name}`}
              >
                {t(expanded ? "mcpStatus.less" : "mcpStatus.more")}
              </Button>
              {expanded && failure ? (
                <Button
                  variant="ghost"
                  size="xs"
                  leftIcon={Copy}
                  onPress={handleCopy}
                  accessibilityLabel={t("mcpStatus.copyError")}
                  style={styles.ghostOnRail}
                  testID={`mcp-status-copy-error-${row.name}`}
                >
                  {t("mcpStatus.copyAction")}
                </Button>
              ) : null}
            </View>
          ) : null}
        </View>
      </ContextMenuTrigger>
      <ContextMenuContent align="start" width={200} testID={`mcp-status-row-menu-${row.name}`}>
        <ContextMenuItem
          leading={hideIcon}
          onSelect={handleHide}
          testID={`mcp-status-menu-hide-${row.name}`}
        >
          {t("mcpStatus.hideAction")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * One line per connected, connecting or disabled server: dot and name, then the status only when
 * it says more than the green dot already does.
 */
function CompactRow({ row }: { row: McpStatusRow }) {
  const { t } = useTranslation();
  const status = compactStatusText(t, row);
  return (
    <View style={styles.compactRow} testID={`mcp-status-row-${row.name}`}>
      <StatusDot tone={row.tone} testID={`mcp-status-dot-${row.name}`} />
      <Text style={styles.compactName} numberOfLines={1}>
        {row.name}
      </Text>
      {status ? (
        <Text style={styles.compactStatus} numberOfLines={1}>
          {status}
        </Text>
      ) : null}
    </View>
  );
}

function HiddenRow({ row, onUnhide }: { row: McpStatusRow; onUnhide: (name: string) => void }) {
  const { t } = useTranslation();
  const handleUnhide = useCallback(() => onUnhide(row.name), [onUnhide, row.name]);
  return (
    <View style={styles.compactRow} testID={`mcp-status-row-${row.name}`}>
      <StatusDot tone={row.tone} testID={`mcp-status-dot-${row.name}`} />
      <Text style={styles.compactName} numberOfLines={1}>
        {row.name}
      </Text>
      <Button
        variant="ghost"
        size="xs"
        onPress={handleUnhide}
        style={styles.ghostOnRail}
        testID={`mcp-status-unhide-${row.name}`}
      >
        {t("mcpStatus.unhideAction")}
      </Button>
    </View>
  );
}

/**
 * The quiet "9 connected" control that opens its group: a ghost button with its chevron beside
 * the label, the label on the name rail. Chrome state, never persisted.
 */
function GroupDisclosure({
  label,
  open,
  onToggle,
  testID,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  testID: string;
}) {
  const accessibilityState = useMemo(() => ({ expanded: open }), [open]);
  // Built here rather than at module scope, like IssueRow's menu icon.
  const chevron = useMemo(
    () =>
      open ? (
        <ThemedChevronUp size={DISCLOSURE_CHEVRON_SIZE} uniProps={foregroundMutedColorMapping} />
      ) : (
        <ThemedChevronDown size={DISCLOSURE_CHEVRON_SIZE} uniProps={foregroundMutedColorMapping} />
      ),
    [open],
  );
  return (
    <Button
      variant="ghost"
      size="xs"
      onPress={onToggle}
      trailing={chevron}
      accessibilityState={accessibilityState}
      style={styles.groupToggle}
      testID={testID}
    >
      {label}
    </Button>
  );
}

export interface McpStatusStripViewProps {
  model: McpStatusStripModel;
  expanded: boolean;
  onToggleExpanded: () => void;
  /** Servers whose sign-in or broker request is in flight; only those rows' buttons wait. */
  pendingNames: ReadonlySet<string>;
  onAction: (row: McpStatusRow) => void;
  onHide: (name: string) => void;
  onUnhide: (name: string) => void;
  onCopyFailure: (row: McpStatusRow, failure: McpStatusActionFailure) => void;
}

/**
 * The MCP status strip itself, from a model and callbacks — mcp-status-strip.tsx wires it to the
 * daemon. Problems first, the ones with a button above the ones without; then the healthy servers
 * folded into one muted row, and the hidden ones folded under another.
 */
export function McpStatusStripView({
  model,
  expanded,
  onToggleExpanded,
  pendingNames,
  onAction,
  onHide,
  onUnhide,
  onCopyFailure,
}: McpStatusStripViewProps) {
  const { t } = useTranslation();
  const [connectedOpen, setConnectedOpen] = useState(false);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const toggleConnected = useCallback(() => setConnectedOpen((previous) => !previous), []);
  const toggleHidden = useCallback(() => setHiddenOpen((previous) => !previous), []);
  const { groups } = model;
  const issueRows = [...groups.actionable, ...groups.stuck];

  return (
    <View style={styles.container} testID="mcp-status-strip">
      <Pressable
        onPress={onToggleExpanded}
        style={styles.summaryRow}
        accessibilityRole="button"
        accessibilityLabel={t(expanded ? "mcpStatus.collapse" : "mcpStatus.expand")}
        testID="mcp-status-summary-toggle"
      >
        <ThemedServer size={CHEVRON_SIZE} uniProps={foregroundMutedColorMapping} />
        <View
          testID="mcp-status-summary-dot"
          style={[styles.dot, toneDotStyle(model.collapsed.tone)]}
        />
        <Text style={styles.summaryText} numberOfLines={1} testID="mcp-status-summary-text">
          {headlineText(t, model.collapsed.headline)}
        </Text>
        {expanded ? (
          <ThemedChevronUp size={CHEVRON_SIZE} uniProps={foregroundMutedColorMapping} />
        ) : (
          <ThemedChevronDown size={CHEVRON_SIZE} uniProps={foregroundMutedColorMapping} />
        )}
      </Pressable>
      {expanded ? (
        <View style={styles.rowList} testID="mcp-status-rows">
          {issueRows.map((row) => (
            <IssueRow
              key={row.key}
              row={row}
              actionPending={pendingNames.has(row.name)}
              onAction={onAction}
              onHide={onHide}
              onCopyFailure={onCopyFailure}
            />
          ))}
          {groups.connected.length > 0 ? (
            <GroupDisclosure
              label={t("mcpStatus.connectedGroup", { count: groups.connected.length })}
              open={connectedOpen}
              onToggle={toggleConnected}
              testID="mcp-status-connected-toggle"
            />
          ) : null}
          {connectedOpen
            ? groups.connected.map((row) => <CompactRow key={row.key} row={row} />)
            : null}
          {groups.hidden.length > 0 ? (
            <GroupDisclosure
              label={t("mcpStatus.hiddenGroup", { count: groups.hidden.length })}
              open={hiddenOpen}
              onToggle={toggleHidden}
              testID="mcp-status-hidden-toggle"
            />
          ) : null}
          {hiddenOpen
            ? groups.hidden.map((row) => <HiddenRow key={row.key} row={row} onUnhide={onUnhide} />)
            : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const nameLineHeight = Math.round(theme.fontSize.sm * LINE_HEIGHT_RATIO);
  // A ghost button's label sits a padding step inside its box. Pulling the box out by that much
  // puts the label's ink on the trailing rail, level with an outline button's border, which is
  // that button's ink; the hit area grows outward instead (docs/design.md §8). The transparent
  // border stays inside, so the box never passes the strip's own edge.
  const ghostInkInset = createControlGeometry(theme).buttonXs.paddingHorizontal;
  // A problem row's first line holds its button, so it is as tall as the button; the name and
  // the dot both centre on it.
  const issueHeadHeight = Math.max(nameLineHeight, buttonControlHeight.xs);
  // Where a row's name starts: the strip's padding, the dot, and the gap after it.
  const nameRail = theme.spacing[3] + DOT_SIZE + theme.spacing[2];
  // How far an xs button's box reaches above a line of text centred in it. Pulling More/Less up
  // by that much puts its label on the line right under the sentence, as plain text would sit.
  const lineOverhang = Math.round((nameLineHeight - buttonControlHeight.xs) / 2);

  return {
    container: {
      borderTopWidth: theme.borderWidth[1],
      borderTopColor: theme.colors.border,
      paddingVertical: theme.spacing[1],
    },
    summaryRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[2],
    },
    summaryText: {
      flex: 1,
      fontSize: theme.fontSize.sm,
      color: theme.colors.foreground,
    },
    rowList: {
      paddingBottom: theme.spacing[1],
    },
    // The sidebar list rhythm (docs/design.md §7): problem rows each carry their own 8px above
    // and below. Compact rows stay tighter.
    issueRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: theme.spacing[2],
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[2],
    },
    issueBody: {
      flex: 1,
      minWidth: 0,
    },
    issueHead: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      minHeight: issueHeadHeight,
    },
    secondLineBlock: {
      // Clips the invisible measuring copy, which still lays out at full height.
      overflow: "hidden",
    },
    name: {
      flex: 1,
      minWidth: 0,
      fontSize: theme.fontSize.sm,
      lineHeight: nameLineHeight,
      color: theme.colors.foreground,
    },
    secondLine: {
      fontSize: theme.fontSize.sm,
      lineHeight: nameLineHeight,
      color: theme.colors.foregroundMuted,
    },
    measureCopy: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      opacity: 0,
    },
    ghostOnRail: {
      marginRight: -ghostInkInset,
    },
    // The leading-edge twin of ghostOnRail: the label's ink on the name rail.
    ghostOnNameRail: {
      marginLeft: -ghostInkInset,
    },
    failureDetails: {
      gap: theme.spacing[1],
      paddingTop: theme.spacing[1],
    },
    // No gap above: More belongs to the sentence it opens, so it sits on the next line of it.
    // Only the top is pulled in; below, the box keeps inside the row, where a touch still lands
    // on Android.
    disclosureLine: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: lineOverhang,
    },
    remedyLine: {
      gap: 1,
    },
    remedyLabel: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
    },
    remedyValue: {
      fontSize: theme.fontSize.sm,
      fontFamily: theme.fontFamily.mono,
      color: theme.colors.foreground,
    },
    compactRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      minHeight: buttonControlHeight.xs,
      paddingHorizontal: theme.spacing[3],
    },
    compactName: {
      flex: 1,
      minWidth: 0,
      fontSize: theme.fontSize.sm,
      color: theme.colors.foreground,
    },
    compactStatus: {
      flexShrink: 1,
      maxWidth: "60%",
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
    },
    // Pulled left by the ghost inset, so the label's ink lands on the name rail.
    groupToggle: {
      alignSelf: "flex-start",
      marginLeft: nameRail - ghostInkInset,
      gap: theme.spacing[1],
    },
    dotSlot: {
      height: nameLineHeight,
      justifyContent: "center",
    },
    issueDotSlot: {
      height: issueHeadHeight,
      justifyContent: "center",
    },
    dot: {
      width: DOT_SIZE,
      height: DOT_SIZE,
      borderRadius: theme.borderRadius.full,
    },
    dotOk: {
      backgroundColor: theme.colors.statusSuccess,
    },
    dotWarning: {
      backgroundColor: theme.colors.statusWarning,
    },
    dotDanger: {
      backgroundColor: theme.colors.statusDanger,
    },
    dotDefault: {
      backgroundColor: theme.colors.foregroundMuted,
    },
  };
});
