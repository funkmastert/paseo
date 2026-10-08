import { useCallback, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import type { KnowledgeBaseNoteSummary } from "@getpaseo/protocol/knowledge-base/rpc-schemas";
import { StyleSheet } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";
import { MenuHeader } from "@/components/headers/menu-header";
import { ScreenHeader } from "@/components/headers/screen-header";
import { HostFilter } from "@/components/hosts/host-filter";
import { SETTINGS_DESKTOP_SIDEBAR_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
import {
  resolveKnowledgeBaseAvailability,
  type KnowledgeBaseAvailability,
} from "@/knowledge-base/availability";
import {
  KnowledgeBaseAvailabilityNotice,
  KnowledgeBaseSidecarNotice,
} from "@/knowledge-base/availability-view";
import { createKnowledgeLeaveGuard, type KnowledgeLeaveGuard } from "@/knowledge-base/leave-guard";
import { KnowledgeNoteList } from "@/knowledge-base/note-list";
import {
  useKnowledgeBaseHost,
  useKnowledgeBaseNotes,
  useKnowledgeBaseStatus,
  type KnowledgeNotesLoadState,
} from "@/knowledge-base/use-knowledge-base";
import { useHosts } from "@/runtime/host-runtime";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import type { HostProfile } from "@/types/host-connection";
import { WindowChromeRegion } from "@/utils/desktop-window";
import {
  buildKnowledgeBaseRoute,
  buildKnowledgeNoteRoute,
  knowledgeNoteRouteId,
} from "@/utils/host-routes";
import { KnowledgeNoteScreen } from "./knowledge-note-screen";

const EMPTY_NOTES: readonly KnowledgeBaseNoteSummary[] = [];

export interface KnowledgeBaseScreenProps {
  /** `?host=`; falls back to the active workspace's host, then the first host. */
  initialServerId: string | null;
  /** The open note's path, or null. */
  selectedPath: string | null;
  /**
   * The route param that carries the open note: `noteId` on the note route, `note` on the list
   * route. Wide layouts switch notes by updating it in place, so the list keeps its search.
   */
  selectionParam: "note" | "noteId";
}

/**
 * The Knowledge screen (KTD-11): a global, host-level view of the project knowledge base. On
 * compact layouts the list and the note are separate pushed routes; on wide layouts they sit side
 * by side, like Settings.
 */
export function KnowledgeBaseScreen(props: KnowledgeBaseScreenProps): ReactElement {
  const isFocused = useIsFocused();
  if (!isFocused) return <View style={styles.container} />;
  return <KnowledgeBaseScreenContent {...props} />;
}

function resolveServerId(
  requested: string | null,
  activeServerId: string | null,
  hosts: readonly HostProfile[],
): string | null {
  const known = (serverId: string | null) =>
    serverId !== null && hosts.some((host) => host.serverId === serverId);
  if (known(requested)) return requested;
  if (known(activeServerId)) return activeServerId;
  return hosts[0]?.serverId ?? null;
}

function KnowledgeBaseScreenContent({
  initialServerId,
  selectedPath,
  selectionParam,
}: KnowledgeBaseScreenProps): ReactElement {
  const { t } = useTranslation();
  const hosts = useHosts();
  const activeWorkspace = useActiveWorkspaceSelection();
  const isCompact = useIsCompactFormFactor();
  const serverId = resolveServerId(initialServerId, activeWorkspace?.serverId ?? null, hosts);
  const host = useKnowledgeBaseHost(serverId);
  const status = useKnowledgeBaseStatus(serverId, host.connected && host.supported);
  const availability = resolveKnowledgeBaseAvailability({
    hasHost: serverId !== null,
    connected: host.connected,
    supportsKnowledgeBase: host.supported,
    status: status.state,
  });
  const notes = useKnowledgeBaseNotes(serverId, availability.kind === "ready");
  const [guard] = useState(createKnowledgeLeaveGuard);

  const openNote = useCallback(
    (path: string) => {
      if (!serverId) return;
      void (async () => {
        if (!(await guard.request())) return;
        if (isCompact) {
          router.push(buildKnowledgeNoteRoute(path, serverId));
          return;
        }
        router.setParams({ [selectionParam]: knowledgeNoteRouteId(path) });
      })();
    },
    [guard, isCompact, selectionParam, serverId],
  );
  const closeNote = useCallback(() => {
    void (async () => {
      if (!(await guard.request())) return;
      if (selectionParam === "note") {
        router.setParams({ note: undefined });
        return;
      }
      if (isCompact && router.canGoBack()) {
        router.back();
        return;
      }
      router.replace(buildKnowledgeBaseRoute(serverId ?? undefined));
    })();
  }, [guard, isCompact, selectionParam, serverId]);
  const selectHost = useCallback(
    (nextServerId: string) => {
      void (async () => {
        if (!(await guard.request())) return;
        router.replace(buildKnowledgeBaseRoute(nextServerId));
      })();
    },
    [guard],
  );

  const shared: KnowledgeBaseLayoutProps = {
    serverId,
    hosts,
    availability,
    notes: notes.state,
    selectedPath,
    guard,
    onRetryStatus: status.refetch,
    onRetryNotes: notes.refetch,
    onSelectHost: selectHost,
    onOpenNote: openNote,
    onCloseNote: closeNote,
    title: t("knowledgeBase.title"),
  };
  if (isCompact) return <KnowledgeBaseCompactLayout {...shared} />;
  return <KnowledgeBaseSplitLayout {...shared} />;
}

interface KnowledgeBaseLayoutProps {
  serverId: string | null;
  hosts: HostProfile[];
  availability: KnowledgeBaseAvailability;
  notes: KnowledgeNotesLoadState;
  selectedPath: string | null;
  guard: KnowledgeLeaveGuard;
  onRetryStatus: () => void;
  onRetryNotes: () => void;
  onSelectHost: (serverId: string) => void;
  onOpenNote: (path: string) => void;
  onCloseNote: () => void;
  title: string;
}

function KnowledgeBaseCompactLayout(props: KnowledgeBaseLayoutProps): ReactElement {
  const { serverId, availability, notes, selectedPath, title } = props;
  if (selectedPath !== null) {
    if (availability.kind === "ready" && serverId) {
      return (
        <KnowledgeNoteScreen
          key={selectedPath}
          serverId={serverId}
          path={selectedPath}
          notes={notes.kind === "loaded" ? notes.notes : EMPTY_NOTES}
          layout="compact"
          guard={props.guard}
          onOpenNote={props.onOpenNote}
          onBack={props.onCloseNote}
        />
      );
    }
    return (
      <View style={styles.container} testID="knowledge-screen">
        <BackHeader title={title} onBack={props.onCloseNote} />
        <KnowledgeBaseBlocked {...props} />
      </View>
    );
  }
  return (
    <View style={styles.container} testID="knowledge-screen">
      <MenuHeader title={title} />
      <KnowledgeBaseListPane {...props} showChevron />
    </View>
  );
}

function KnowledgeBaseSplitLayout(props: KnowledgeBaseLayoutProps): ReactElement {
  const { t } = useTranslation();
  const { serverId, availability, notes, selectedPath, title } = props;
  if (availability.kind !== "ready" || !serverId) {
    return (
      <View style={styles.container} testID="knowledge-screen">
        <MenuHeader title={title} />
        <KnowledgeBaseBlocked {...props} />
      </View>
    );
  }
  return (
    <View style={styles.container} testID="knowledge-screen">
      <View style={styles.splitRow}>
        <WindowChromeRegion corners="top-left">
          <View style={styles.listPane}>
            <MenuHeader title={title} />
            <KnowledgeBaseListPane {...props} showChevron={false} />
          </View>
        </WindowChromeRegion>
        <WindowChromeRegion corners="top-right">
          <View style={styles.detailPane} testID="knowledge-detail-pane">
            {selectedPath !== null ? (
              <KnowledgeNoteScreen
                key={selectedPath}
                serverId={serverId}
                path={selectedPath}
                notes={notes.kind === "loaded" ? notes.notes : EMPTY_NOTES}
                layout="pane"
                guard={props.guard}
                onOpenNote={props.onOpenNote}
                onBack={props.onCloseNote}
              />
            ) : (
              <View style={styles.container}>
                <ScreenHeader borderless />
                <View style={styles.centered}>
                  <Text style={styles.mutedText}>{t("knowledgeBase.list.selectNote")}</Text>
                </View>
              </View>
            )}
          </View>
        </WindowChromeRegion>
      </View>
    </View>
  );
}

function HostRail({
  hosts,
  serverId,
  onSelectHost,
}: Pick<KnowledgeBaseLayoutProps, "hosts" | "serverId" | "onSelectHost">): ReactElement | null {
  if (hosts.length < 2) return null;
  return (
    <View style={styles.hostRail}>
      <HostFilter
        hosts={hosts}
        selectedHost={serverId ?? ""}
        onSelectHost={onSelectHost}
        includeAllHost={false}
        triggerTestID="knowledge-host-trigger"
      />
    </View>
  );
}

function KnowledgeBaseBlocked(props: KnowledgeBaseLayoutProps): ReactElement | null {
  const { availability } = props;
  if (availability.kind === "ready") return null;
  return (
    <View style={styles.blocked}>
      <HostRail hosts={props.hosts} serverId={props.serverId} onSelectHost={props.onSelectHost} />
      <View style={styles.blockedColumn}>
        <KnowledgeBaseAvailabilityNotice
          availability={availability}
          onRetry={props.onRetryStatus}
        />
      </View>
    </View>
  );
}

function KnowledgeBaseListPane(
  props: KnowledgeBaseLayoutProps & { showChevron: boolean },
): ReactElement | null {
  const { availability, serverId } = props;
  if (availability.kind !== "ready" || !serverId) return <KnowledgeBaseBlocked {...props} />;
  return (
    <View style={styles.container}>
      <HostRail hosts={props.hosts} serverId={serverId} onSelectHost={props.onSelectHost} />
      {availability.banner ? (
        <View style={styles.banner}>
          <KnowledgeBaseSidecarNotice banner={availability.banner} />
        </View>
      ) : null}
      <KnowledgeNoteList
        key={serverId}
        serverId={serverId}
        notes={props.notes}
        onRetry={props.onRetryNotes}
        fullTextSearch={availability.fullTextSearch}
        selectedPath={props.selectedPath}
        showChevron={props.showChevron}
        onOpenNote={props.onOpenNote}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  splitRow: {
    flex: 1,
    flexDirection: "row",
  },
  listPane: {
    width: SETTINGS_DESKTOP_SIDEBAR_WIDTH,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  detailPane: {
    flex: 1,
    minWidth: 0,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  hostRail: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
  },
  banner: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
  },
  blocked: {
    flex: 1,
  },
  blockedColumn: {
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[6],
  },
}));
