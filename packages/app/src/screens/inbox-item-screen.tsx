import { useCallback, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import type { InboxActVerb } from "@getpaseo/protocol/coordination/rpc-schemas";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { useFetchQuery } from "@/data/query";
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useInboxAct } from "@/hooks/use-inbox";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { toErrorMessage } from "@/utils/error-messages";
import { formatCompactTimeAgo } from "@/utils/time";

export interface InboxItemScreenProps {
  serverId: string;
  itemId: string;
}

const OPEN_STATES = new Set(["pending", "in-progress", "blocked"]);

/** OR-A5: a work item's detail, its transitions, and the five verbs that act on it as `human`.
 * See docs/work-queue.md#inbox. */
export function InboxItemScreen({ serverId, itemId }: InboxItemScreenProps): ReactElement {
  const router = useRouter();
  const runtime = getHostRuntimeStore();
  const [note, setNote] = useState("");
  const [showRoutePicker, setShowRoutePicker] = useState(false);
  const act = useInboxAct();
  const { agents } = useAggregatedAgents();
  const hostAgents = useMemo(
    () => agents.filter((agent) => agent.serverId === serverId && !agent.archivedAt),
    [agents, serverId],
  );

  const query = useFetchQuery({
    queryKey: ["inboxItem", serverId, itemId],
    queryFn: async () => {
      const client = runtime.getClient(serverId);
      if (!client) {
        throw new Error("This host is not connected.");
      }
      const result = await client.coordinationQueueShow({ id: itemId });
      if (result.error) {
        throw new Error(result.error);
      }
      if (!result.item) {
        throw new Error("This item could not be found.");
      }
      return { item: result.item, transitions: result.transitions ?? [] };
    },
    dataShape: "value",
    staleTimeMs: 5_000,
  });

  const { mutate } = act;
  const runVerb = useCallback(
    (verb: InboxActVerb, extra?: { note?: string; to?: string }): void => {
      mutate(
        {
          serverId,
          id: itemId,
          verb,
          ...(extra?.note ? { note: extra.note } : {}),
          ...(extra?.to ? { to: extra.to } : {}),
        },
        {
          onSuccess: () => {
            setNote("");
            setShowRoutePicker(false);
            if (verb !== "annotate" && router.canGoBack()) {
              router.back();
            }
          },
        },
      );
    },
    [mutate, serverId, itemId, router],
  );
  const handleApprove = useCallback(() => runVerb("approve"), [runVerb]);
  const handleDeny = useCallback(() => runVerb("deny"), [runVerb]);
  const handleHold = useCallback(() => runVerb("hold"), [runVerb]);
  const handleDrop = useCallback(() => runVerb("drop"), [runVerb]);
  const handleAnnotate = useCallback(() => runVerb("annotate", { note }), [runVerb, note]);
  const handleToggleRoutePicker = useCallback(() => setShowRoutePicker((value) => !value), []);
  const handleRoute = useCallback(
    (agentId: string) => runVerb("route", { to: agentId }),
    [runVerb],
  );

  if (query.isLoading) {
    return (
      <View style={styles.container}>
        <MenuHeader title="Request" />
        <View style={styles.centered}>
          <LoadingSpinner size="large" color={styles.spinner.color} />
        </View>
      </View>
    );
  }

  if (query.isError || !query.data) {
    return (
      <View style={styles.container}>
        <MenuHeader title="Request" />
        <View style={styles.centered}>
          <Text style={styles.errorText}>{toErrorMessage(query.error ?? "Not found")}</Text>
        </View>
      </View>
    );
  }

  const { item, transitions } = query.data;
  const isOpen = OPEN_STATES.has(item.state);

  return (
    <View style={styles.container}>
      <MenuHeader title="Request" />
      <ScrollView contentContainerStyle={styles.scrollContent} testID="inbox-item-detail">
        <View style={styles.headerRow}>
          <Text style={styles.title}>{item.title}</Text>
          <StatusBadge label={item.state} />
        </View>
        {item.body ? <Text style={styles.body}>{item.body}</Text> : null}
        <Text style={styles.meta}>
          {`${item.createdBy ? `from ${item.createdBy} · ` : ""}created ${formatCompactTimeAgo(
            new Date(item.createdAt),
          )}`}
        </Text>
        {item.closure ? (
          <Text style={styles.meta}>
            {`closure: ${item.closure.reason}${
              item.closure.target ? ` → ${item.closure.target}` : ""
            }`}
          </Text>
        ) : null}
        {item.delivery?.state === "failed" ? (
          <Text style={styles.errorText}>{`delivery failed: ${item.delivery.reason ?? ""}`}</Text>
        ) : null}

        {isOpen ? (
          <>
            <View style={styles.actionsRow}>
              <Button onPress={handleApprove} loading={act.isPending} testID="inbox-action-approve">
                Approve
              </Button>
              <Button
                variant="destructive"
                onPress={handleDeny}
                loading={act.isPending}
                testID="inbox-action-deny"
              >
                Deny
              </Button>
              <Button
                variant="outline"
                onPress={handleHold}
                loading={act.isPending}
                testID="inbox-action-hold"
              >
                Hold
              </Button>
              <Button
                variant="outline"
                onPress={handleDrop}
                loading={act.isPending}
                testID="inbox-action-drop"
              >
                Drop
              </Button>
            </View>

            <Field label="Note">
              <FormTextInput
                initialValue={note}
                onChangeText={setNote}
                placeholder="Add a note"
                testID="inbox-note-input"
              />
            </Field>
            <Button
              variant="outline"
              onPress={handleAnnotate}
              disabled={note.trim().length === 0}
              loading={act.isPending}
              testID="inbox-action-annotate"
            >
              Annotate
            </Button>

            <Button
              variant="outline"
              onPress={handleToggleRoutePicker}
              testID="inbox-action-route-toggle"
            >
              Route to an agent
            </Button>
            {showRoutePicker ? (
              <View style={styles.routeList} testID="inbox-route-agent-list">
                {hostAgents.length === 0 ? (
                  <Text style={styles.meta}>No agents on this host.</Text>
                ) : (
                  hostAgents.map((agent) => (
                    <RouteAgentButton
                      key={agent.id}
                      agent={agent}
                      onRoute={handleRoute}
                      loading={act.isPending}
                    />
                  ))
                )}
              </View>
            ) : null}
          </>
        ) : null}

        {act.isError ? <Text style={styles.errorText}>{toErrorMessage(act.error)}</Text> : null}

        <Text style={styles.sectionTitle}>Transitions</Text>
        <View style={styles.transitions}>
          {transitions.map((row) => (
            <View key={row.seq} style={styles.transitionRow}>
              <Text style={styles.transitionText}>
                {`${row.from ?? "new"} → ${row.to}${row.actor ? ` (${row.actor})` : ""}`}
              </Text>
              <Text style={styles.meta}>{formatCompactTimeAgo(new Date(row.at))}</Text>
              {row.note ? <Text style={styles.meta}>{row.note}</Text> : null}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function RouteAgentButton({
  agent,
  onRoute,
  loading,
}: {
  agent: AggregatedAgent;
  onRoute: (agentId: string) => void;
  loading: boolean;
}): ReactElement {
  const handlePress = useCallback(() => onRoute(agent.id), [onRoute, agent.id]);
  return (
    <Button
      variant="ghost"
      onPress={handlePress}
      loading={loading}
      testID={`inbox-route-agent-${agent.id}`}
    >
      {agent.title ?? agent.id}
    </Button>
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
  scrollContent: {
    gap: theme.spacing[4],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[8],
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  title: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  body: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  meta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
  actionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  routeList: {
    gap: theme.spacing[1],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
  },
  transitions: {
    gap: theme.spacing[3],
  },
  transitionRow: {
    gap: 2,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    paddingBottom: theme.spacing[2],
  },
  transitionText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
}));
