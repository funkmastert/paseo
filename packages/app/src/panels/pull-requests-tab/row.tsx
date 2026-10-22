import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { PullRequestStateIcon } from "@/git/pull-request-state-icon";
import type { PullRequestLedgerEntry } from "@getpaseo/protocol/pull-requests/rpc-schemas";
import { useRowPullRequestStatus } from "./use-row-status";

export interface PullRequestRowProps {
  serverId: string;
  entry: PullRequestLedgerEntry;
  isOpen: boolean;
  onPress: (entry: PullRequestLedgerEntry) => void;
}

function checksStatusLabel(
  t: (key: string) => string,
  checksStatus: string | undefined,
): string | null {
  switch (checksStatus) {
    case "success":
      return t("panels.pullRequests.checks.success");
    case "failure":
      return t("panels.pullRequests.checks.failure");
    case "pending":
      return t("panels.pullRequests.checks.pending");
    default:
      return null;
  }
}

function reviewDecisionLabel(
  t: (key: string) => string,
  reviewDecision: string | null | undefined,
): string | null {
  switch (reviewDecision) {
    case "approved":
      return t("panels.pullRequests.review.approved");
    case "changes_requested":
      return t("panels.pullRequests.review.changesRequested");
    case "pending":
      return t("panels.pullRequests.review.pending");
    default:
      return null;
  }
}

export function PullRequestRow({ serverId, entry, isOpen, onPress }: PullRequestRowProps) {
  const { t } = useTranslation();
  const rowStatus = useRowPullRequestStatus({ serverId, entry, enabled: isOpen });
  const handlePress = useCallback(() => onPress(entry), [onPress, entry]);
  const checksLabel = checksStatusLabel(t, rowStatus.checksStatus);
  const reviewLabel = reviewDecisionLabel(t, rowStatus.reviewDecision);

  return (
    <Pressable
      style={styles.row}
      onPress={handlePress}
      testID={`pull-request-row-${entry.id}`}
      accessibilityRole="button"
    >
      <View style={styles.leading}>
        <PullRequestStateIcon state={rowStatus.state} size={14} />
      </View>
      <View style={styles.titleColumn}>
        <Text style={styles.title} numberOfLines={1}>
          {entry.creatingAgentTitle ?? t("panels.pullRequests.untitled", { number: entry.number })}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {`${entry.repoOwner}/${entry.repoName} #${entry.number}`}
        </Text>
      </View>
      <View style={styles.trailing}>
        {reviewLabel ? <Text style={styles.statusLabel}>{reviewLabel}</Text> : null}
        {checksLabel ? <Text style={styles.statusLabel}>{checksLabel}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  leading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  titleColumn: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  title: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  subtitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  trailing: {
    alignItems: "flex-end",
    gap: 2,
  },
  statusLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
