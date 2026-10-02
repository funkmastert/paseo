import { useCallback, useMemo, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { useInbox } from "@/hooks/use-inbox";
import {
  buildHumanRequestRow,
  buildUpdateRow,
  selectHumanRequests,
  selectUpdates,
  type HumanRequestRow,
  type UpdateRow,
} from "@/inbox/model";
import { formatCompactTimeAgo } from "@/utils/time";
import { buildInboxItemRoute } from "@/utils/host-routes";
import type { WorkItemState } from "@getpaseo/protocol/coordination/queue-schemas";

export function InboxScreen(): ReactElement {
  const router = useRouter();
  const { loadState, hostErrors, isError, refetch, isRefetching } = useInbox();

  const requestRows = useMemo(() => {
    if (loadState.status !== "loaded") return [];
    const nowMs = Date.now();
    return selectHumanRequests(loadState.requests).map((item) => buildHumanRequestRow(item, nowMs));
  }, [loadState]);

  const updateRows = useMemo(() => {
    if (loadState.status !== "loaded") return [];
    const nowMs = Date.now();
    return selectUpdates(loadState.updates).map((entry) => buildUpdateRow(entry, nowMs));
  }, [loadState]);

  const isLoading = loadState.status !== "loaded";

  const openRequest = useCallback(
    (row: HumanRequestRow) => {
      router.push(buildInboxItemRoute(row.serverId, row.id));
    },
    [router],
  );

  return (
    <View style={styles.container}>
      <MenuHeader title="Inbox" />
      {isLoading ? (
        <View style={styles.centered}>
          <LoadingSpinner size="large" color={styles.spinner.color} />
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          testID="inbox-list"
        >
          {hostErrors.length > 0 ? (
            <View style={styles.errorsBanner} testID="inbox-host-errors">
              {hostErrors.map((error) => (
                <Text key={error.serverId} style={styles.errorsBannerText}>
                  {`${error.serverName}: Could not load the Inbox`}
                </Text>
              ))}
            </View>
          ) : null}

          <InboxSection title="Human requests" testID="inbox-human-requests">
            {requestRows.length === 0 ? (
              <Text style={styles.emptyText}>Nothing needs you right now.</Text>
            ) : (
              requestRows.map((row) => (
                <HumanRequestRowView
                  key={`${row.serverId}:${row.id}`}
                  row={row}
                  onOpen={openRequest}
                />
              ))
            )}
          </InboxSection>

          <InboxSection title="Updates" testID="inbox-updates">
            {updateRows.length === 0 ? (
              <Text style={styles.emptyText}>Nothing yet.</Text>
            ) : (
              updateRows.map((row) => <UpdateRowView key={`${row.serverId}:${row.id}`} row={row} />)
            )}
          </InboxSection>

          {isError ? (
            <Button variant="outline" onPress={refetch} loading={isRefetching} testID="inbox-retry">
              Try again
            </Button>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

function InboxSection({
  title,
  testID,
  children,
}: {
  title: string;
  testID?: string;
  children: React.ReactNode;
}): ReactElement {
  return (
    <View style={styles.section} testID={testID}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

const STATE_BADGE_VARIANT: Record<WorkItemState, StatusBadgeVariant> = {
  pending: "muted",
  "in-progress": "muted",
  done: "success",
  blocked: "warning",
  failed: "error",
  denied: "error",
  canceled: "muted",
  "handed-off": "muted",
};

function HumanRequestRowView({
  row,
  onOpen,
}: {
  row: HumanRequestRow;
  onOpen: (row: HumanRequestRow) => void;
}): ReactElement {
  const age = formatCompactTimeAgo(new Date(Date.now() - row.ageMs));
  const handlePress = useCallback(() => onOpen(row), [onOpen, row]);
  return (
    <Pressable onPress={handlePress} style={styles.row} testID="inbox-request-row">
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {row.title}
        </Text>
        <Text style={styles.rowSubtitle} numberOfLines={1}>
          {row.creator ? `${row.creator} · ${age}` : age}
          {row.deliveryFailed ? " · delivery failed" : ""}
        </Text>
      </View>
      <StatusBadge label={row.state} variant={STATE_BADGE_VARIANT[row.state]} />
    </Pressable>
  );
}

function UpdateRowView({ row }: { row: UpdateRow }): ReactElement {
  const age = formatCompactTimeAgo(new Date(Date.now() - row.ageMs));
  return (
    <View style={styles.row} testID="inbox-update-row">
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {row.summary}
        </Text>
        <Text style={styles.rowSubtitle} numberOfLines={1}>
          {`${row.source} · ${age}`}
        </Text>
      </View>
      {row.urgency === "high" ? <StatusBadge label="high" variant="error" /> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    gap: theme.spacing[4],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  section: {
    gap: theme.spacing[2],
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
  },
  sectionBody: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  emptyText: {
    padding: theme.spacing[4],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  rowMain: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  rowSubtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorsBanner: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  errorsBannerText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
}));
