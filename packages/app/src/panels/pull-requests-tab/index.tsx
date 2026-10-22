import { useCallback, useEffect, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
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
import type { PullRequestLedgerEntry } from "@getpaseo/protocol/pull-requests/rpc-schemas";
import { usePullRequests } from "./use-pull-requests";
import { PullRequestRow } from "./row";

export interface PullRequestsTabContentProps {
  serverId: string;
  workspaceId?: string | null;
  isOpen: boolean;
}

function toIdentity(entry: PullRequestLedgerEntry): PullRequestIdentity {
  return {
    host: entry.host,
    repoOwner: entry.repoOwner,
    repoName: entry.repoName,
    number: entry.number,
    cwd: entry.creatingAgentCwd,
  };
}

function PullRequestDetail({
  serverId,
  workspaceId,
  entry,
  onBack,
}: {
  serverId: string;
  workspaceId?: string | null;
  entry: PullRequestLedgerEntry;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const identity = toIdentity(entry);
  const prPane = usePrPaneDataByIdentity({ serverId, identity });

  const handleRetry = useCallback(() => {
    void Linking.openURL(entry.url);
  }, [entry.url]);

  // KTD6's fallback: a forge with no identity-based status lookup opens the PR URL instead of a
  // broken detail view.
  useEffect(() => {
    if (prPane.unsupportedForge) void Linking.openURL(entry.url);
  }, [prPane.unsupportedForge, entry.url]);

  const renderContent = () => {
    if (prPane.unsupportedForge) {
      return <PullRequestPaneSkeleton />;
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
      return <PullRequestPaneError onRetry={handleRetry} />;
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
  const [selected, setSelected] = useState<PullRequestLedgerEntry | null>(null);
  const { pullRequests, isLoading, isError } = usePullRequests({
    serverId,
    workspaceId,
    enabled: isOpen,
  });

  const handleBack = useCallback(() => setSelected(null), []);

  if (selected) {
    return (
      <PullRequestDetail
        serverId={serverId}
        workspaceId={workspaceId}
        entry={selected}
        onBack={handleBack}
      />
    );
  }

  if (isError) {
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
      {pullRequests.map((entry) => (
        <PullRequestRow key={entry.id} serverId={serverId} entry={entry} onPress={setSelected} />
      ))}
    </View>
  );
}

export type { PullRequestLedgerEntry };

const styles = StyleSheet.create((theme) => ({
  list: {
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
  },
}));
