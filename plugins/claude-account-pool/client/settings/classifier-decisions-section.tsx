import { useMemo, useRef } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { WORK_KINDS } from "../../shared/arena-aliases";
import { ClassifierDecisionsRow } from "./classifier-decisions-row";
import { DEFAULT_CLASSIFIER_DECISIONS_FILTERS, useClassifierDecisions } from "./use-classifier-decisions";

const ALL_OPTION = { label: "All", value: "" };

function formatPct(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function topEntries(counts: Record<string, number>, n: number): Array<[string, number]> {
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, n);
}

/** The Decisions view on the plugin's existing Agent Model Policy screen (R3-R7, KTD-6). */
export function ClassifierDecisionsSection({ theme, layout, navigation }: PluginSurfaceProps) {
  const { filters, setFilters, load, reload, loadMore } = useClassifierDecisions();
  const onOpenAgent = navigation?.openAgent ? (agentId: string) => navigation.openAgent({ agentId }) : undefined;
  const seenRoles = useRef(new Set<string>());
  const seenWorkKinds = useRef(new Set<string>(WORK_KINDS));

  if (load.status === "ready") {
    for (const entry of load.rows) {
      if (entry.role) seenRoles.current.add(entry.role);
      if (entry.workKind) seenWorkKinds.current.add(entry.workKind);
    }
  }
  const roleOptions = useMemo(
    () => [ALL_OPTION, ...[...seenRoles.current].sort().map((role) => ({ label: role, value: role }))],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `seenRoles` only grows; recomputed whenever a load completes.
    [load],
  );
  const workKindOptions = useMemo(
    () => [ALL_OPTION, ...[...seenWorkKinds.current].sort().map((kind) => ({ label: kind, value: kind }))],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [load],
  );

  return (
    <SettingsSection
      title="Decisions"
      info={
        <Text style={{ color: theme.colors.foregroundMuted }}>
          What the arena-ranking classifier would have picked, and whether it agrees with the model that actually ran
          (docs/arena-ranking.md). Read-only — this does not change shadow mode.
        </Text>
      }
      testID="classifier-decisions-section"
    >
      {load.status === "loading" ? <ActivityIndicator /> : null}
      {load.status === "error" ? (
        <View>
          <Text style={{ color: theme.colors.statusDanger }}>{load.error}</Text>
          <SettingsAction label="Reload" actionLabel="Try again" onPress={reload} testID="classifier-decisions-reload" />
        </View>
      ) : null}
      {load.status === "ready" ? (
        <>
          <View style={{ gap: 4, paddingBottom: 8 }} testID="classifier-decisions-summary">
            <Text style={{ color: theme.colors.foreground }}>
              Agreement rate: {formatPct(load.summary.agreementRate)} ({load.summary.rankedCount} ranked,{" "}
              {load.summary.fallbackCount} fallback) · Top tier: {formatPct(load.summary.topTierRate)}
            </Text>
            {!layout.compact && topEntries(load.summary.pickDistributionByModel, 3).length > 0 ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                Would-be picks: {topEntries(load.summary.pickDistributionByModel, 3).map(([model, count]) => `${model} (${count})`).join(", ")}
              </Text>
            ) : null}
            {!layout.compact && topEntries(load.summary.fallbackReasonCounts, 3).length > 0 ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                Fallback reasons: {topEntries(load.summary.fallbackReasonCounts, 3).map(([reason, count]) => `${reason} (${count})`).join(", ")}
              </Text>
            ) : null}
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontStyle: "italic" }}>{load.summary.caveat}</Text>
          </View>

          <SettingsSwitch
            label="Disagreements only"
            value={filters.disagreementsOnly}
            onValueChange={(value) => setFilters({ ...filters, disagreementsOnly: value })}
            testID="classifier-decisions-disagreements-only"
          />
          <SettingsSelect
            label="Role"
            value={filters.role}
            options={roleOptions}
            onValueChange={(value) => setFilters({ ...filters, role: value })}
            testID="classifier-decisions-role-filter"
          />
          <SettingsSelect
            label="Work kind"
            value={filters.workKind}
            options={workKindOptions}
            onValueChange={(value) => setFilters({ ...filters, workKind: value })}
            testID="classifier-decisions-work-kind-filter"
          />
          {filters.disagreementsOnly || filters.role || filters.workKind ? (
            <SettingsAction
              label="Filters applied"
              actionLabel="Clear filters"
              onPress={() => setFilters(DEFAULT_CLASSIFIER_DECISIONS_FILTERS)}
              testID="classifier-decisions-clear-filters"
            />
          ) : null}

          {load.rows.length === 0 ? (
            <Text style={{ color: theme.colors.foregroundMuted, paddingVertical: 12 }}>No decisions match these filters.</Text>
          ) : (
            load.rows.map((entry) => (
              <ClassifierDecisionsRow key={entry.id} entry={entry} theme={theme} onOpenAgent={onOpenAgent} />
            ))
          )}
          {load.nextCursor ? (
            <SettingsAction
              label={load.loadMoreError ? `Couldn't load more: ${load.loadMoreError}` : `${load.rows.length} shown`}
              actionLabel={load.loadingMore ? "Loading…" : load.loadMoreError ? "Retry" : "Load more"}
              onPress={loadMore}
              disabled={load.loadingMore}
              testID="classifier-decisions-load-more"
            />
          ) : null}
        </>
      ) : null}
    </SettingsSection>
  );
}
