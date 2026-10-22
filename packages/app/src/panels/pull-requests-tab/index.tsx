import { useCallback, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ChevronLeft } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  PullRequestPane,
  PullRequestPaneError,
  PullRequestPaneSkeleton,
} from "@/git/pull-request-panel";
import { buildWorkspaceAttachmentScopeKey } from "@/attachments/workspace-attachments-store";
import {
  usePrPaneDataByIdentity,
  type PullRequestIdentity,
} from "@/git/pull-request-panel/use-data-by-identity";
import { openExternalUrl } from "@/utils/open-external-url";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import type { PullRequestLedgerEntry } from "@getpaseo/protocol/pull-requests/rpc-schemas";
import { usePullRequests } from "./use-pull-requests";
import { resolveStatusCwd } from "./use-row-status";
import { PullRequestRow } from "./row";

export interface PullRequestsTabContentProps {
  serverId: string;
  workspaceId?: string | null;
  isOpen: boolean;
}

/** The creating agent's cwd selects which authenticated CLI context a status fetch runs from —
 * fall back to the viewing workspace's own cwd when that agent is gone (archived, restarted). */
function toIdentity(
  entry: PullRequestLedgerEntry,
  fallbackCwd: string | null,
): PullRequestIdentity {
  return {
    host: entry.host,
    repoOwner: entry.repoOwner,
    repoName: entry.repoName,
    number: entry.number,
    cwd: resolveStatusCwd(entry.creatingAgentCwd, fallbackCwd),
  };
}

function PullRequestDetail({
  serverId,
  workspaceId,
  entry,
  isOpen,
  onBack,
}: {
  serverId: string;
  workspaceId?: string | null;
  entry: PullRequestLedgerEntry;
  isOpen: boolean;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const fallbackCwd = useWorkspaceDirectory(serverId, workspaceId ?? null);
  const identity = toIdentity(entry, fallbackCwd);
  const prPane = usePrPaneDataByIdentity({ serverId, identity, enabled: isOpen });

  const handleOpenInBrowser = useCallback(() => {
    void openExternalUrl(entry.url);
  }, [entry.url]);

  const renderContent = () => {
    // A forge with no identity-based status lookup can't drive a detail view; let the person
    // open the PR itself instead of showing a skeleton that never resolves.
    if (prPane.unsupportedForge) {
      return (
        <View style={styles.empty} testID="pull-request-detail-unsupported">
          <Text style={styles.emptyDescription}>
            {t("panels.pullRequest.unsupportedForgeDescription")}
          </Text>
          <Pressable
            onPress={handleOpenInBrowser}
            accessibilityRole="button"
            testID="pull-request-detail-open-in-browser"
          >
            <Text style={styles.link}>{t("panels.pullRequest.openInBrowser")}</Text>
          </Pressable>
        </View>
      );
    }
    if (prPane.data) {
      return (
        <PullRequestPane
          serverId={serverId}
          cwd={identity.cwd}
          data={prPane.data}
          activityLoading={prPane.activityLoading}
          workspaceAttachmentScopeKey={buildWorkspaceAttachmentScopeKey({
            serverId,
            workspaceId,
            cwd: identity.cwd,
          })}
        />
      );
    }
    if (prPane.error) {
      return <PullRequestPaneError onRetry={prPane.refetch} />;
    }
    return <PullRequestPaneSkeleton />;
  };

  return (
    <View style={styles.detail}>
      <Pressable
        style={styles.backRow}
        onPress={onBack}
        testID="pull-request-detail-back"
        accessibilityRole="button"
        accessibilityLabel={t("panels.pullRequests.back")}
      >
        <ChevronLeft size={16} />
        <Text style={styles.backLabel}>{t("panels.pullRequests.back")}</Text>
      </Pressable>
      {renderContent()}
    </View>
  );
}

export function PullRequestsTabContent({
  serverId,
  workspaceId,
  isOpen,
}: PullRequestsTabContentProps) {
  const { t } = useTranslation();
  const [selected, setSelectedState] = useState<PullRequestLedgerEntry | null>(null);
  const fallbackCwd = useWorkspaceDirectory(serverId, workspaceId ?? null);
  const { pullRequests, isLoading, isError } = usePullRequests({
    serverId,
    workspaceId,
    enabled: isOpen,
  });

  const handleBack = useCallback(() => setSelectedState(null), [setSelectedState]);
  const renderRow = useCallback(
    ({ item }: { item: PullRequestLedgerEntry }) => (
      <PullRequestRow
        serverId={serverId}
        entry={item}
        fallbackCwd={fallbackCwd}
        isOpen={isOpen}
        onPress={setSelectedState}
      />
    ),
    [serverId, fallbackCwd, isOpen, setSelectedState],
  );
  const keyExtractor = useCallback((entry: PullRequestLedgerEntry) => entry.id, []);

  if (selected) {
    return (
      <PullRequestDetail
        serverId={serverId}
        workspaceId={workspaceId}
        entry={selected}
        isOpen={isOpen}
        onBack={handleBack}
      />
    );
  }

  // An error with cached rows to show still shows them, with an inline note — only a bare
  // error (no prior successful fetch) replaces the list entirely.
  if (isError && pullRequests.length === 0) {
    return (
      <View style={styles.empty} testID="pull-requests-error-state">
        <Text style={styles.emptyTitle}>{t("panels.pullRequests.errorTitle")}</Text>
        <Text style={styles.emptyDescription}>{t("panels.pullRequests.errorDescription")}</Text>
      </View>
    );
  }

  if (!isLoading && pullRequests.length === 0) {
    return (
      <View style={styles.empty} testID="pull-requests-empty-state">
        <Text style={styles.emptyTitle}>{t("panels.pullRequests.emptyTitle")}</Text>
        <Text style={styles.emptyDescription}>{t("panels.pullRequests.emptyDescription")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.list} testID="pull-requests-list">
      {isError ? (
        <Text style={styles.inlineError} testID="pull-requests-inline-error">
          {t("panels.pullRequests.errorTitle")}
        </Text>
      ) : null}
      <FlatList
        data={pullRequests}
        keyExtractor={keyExtractor}
        renderItem={renderRow}
        style={styles.flatList}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    flex: 1,
  },
  flatList: {
    flex: 1,
  },
  detail: {
    flex: 1,
  },
  backRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    padding: theme.spacing[2],
  },
  backLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: 24,
  },
  emptyTitle: {
    color: theme.colors.foreground,
  },
  emptyDescription: {
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  inlineError: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  link: {
    color: theme.colors.accent,
  },
}));
