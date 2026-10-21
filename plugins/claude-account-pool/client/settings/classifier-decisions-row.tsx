import { Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { RpcOutput } from "@getpaseo/plugin";
import type { classifierDecisionsRpc } from "../../shared/classifier-decisions-rpc";
import { rowAgreement } from "../../shared/classifier-decisions-aggregate";

type Entry = RpcOutput<typeof classifierDecisionsRpc.list>["rows"][number];

export interface ClassifierDecisionsRowProps {
  entry: Entry;
  theme: PluginSurfaceProps["theme"];
  onOpenAgent?: (agentId: string) => void;
}

function formatTokens(tokens: number | null): string | undefined {
  if (tokens === null) return undefined;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M tok`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K tok`;
  return `${Math.round(tokens)} tok`;
}

function formatDuration(ms: number | null): string | undefined {
  if (ms === null) return undefined;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function Pill({ label, color, background }: { label: string; color: string; background: string }) {
  return (
    <View style={{ borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, backgroundColor: background }}>
      <Text style={{ fontSize: 12, color }}>{label}</Text>
    </View>
  );
}

const OUTCOME_LABELS: Record<Entry["outcome"]["state"], string> = {
  running: "Running",
  finished: "Finished",
  errored: "Errored",
  archived: "Archived",
  unknown: "Unknown",
};

/** One row in the Decisions list (R3), newest-first. */
export function ClassifierDecisionsRow({ entry, theme, onOpenAgent }: ClassifierDecisionsRowProps) {
  const { colors } = theme;
  const title = entry.agentTitle ?? entry.agentId;
  const agreement = rowAgreement(entry);
  const outcomeColors: Record<Entry["outcome"]["state"], string> = {
    errored: colors.statusDanger,
    finished: colors.statusSuccess,
    running: colors.foregroundMuted,
    archived: colors.foregroundMuted,
    unknown: colors.foregroundMuted,
  };
  const outcomeColor = outcomeColors[entry.outcome.state];

  return (
    <View style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 4 }} testID={`classifier-decision-row-${entry.id}`}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        {onOpenAgent ? (
          <Pressable onPress={() => onOpenAgent(entry.agentId)} hitSlop={6}>
            <Text style={{ color: colors.accent }}>{title}</Text>
          </Pressable>
        ) : (
          <Text style={{ color: colors.foreground }}>{title}</Text>
        )}
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{new Date(entry.at).toLocaleString()}</Text>
      </View>

      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
        {[entry.role, entry.taskClass, entry.workKind].filter((value): value is string => value !== null).join(" · ") || "no role/class/kind recorded"}
        {entry.backfilled ? " · backfilled" : ""}
      </Text>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {entry.arena.outcome === "ranked" ? (
          <>
            <Text style={{ color: colors.foreground, fontSize: 13 }}>
              Ran {entry.modelRan ?? "unknown"} · would pick {entry.arena.ref} ({entry.arena.tier}
              {entry.arena.pick.proxy ? ", proxy" : ""}
              {entry.arena.applied ? ", applied" : ", shadowed"})
            </Text>
            {agreement !== "unknown" ? (
              <Pill
                label={agreement === "agree" ? "Agree" : "Disagree"}
                color={agreement === "agree" ? colors.statusSuccess : colors.statusWarning}
                background={colors.surface1}
              />
            ) : null}
          </>
        ) : (
          <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>
            Ran {entry.modelRan ?? "unknown"} · no pick ({entry.arena.reason})
          </Text>
        )}
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Pill label={OUTCOME_LABELS[entry.outcome.state]} color={outcomeColor} background={colors.surface1} />
        {entry.outcome.completion ? <Pill label={entry.outcome.completion} color={colors.statusSuccess} background={colors.surface1} /> : null}
        {entry.outcome.moved ? <Pill label="Moved accounts" color={colors.statusWarning} background={colors.surface1} /> : null}
        {formatTokens(entry.outcome.tokens) ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{formatTokens(entry.outcome.tokens)}</Text> : null}
        {formatDuration(entry.outcome.durationMs) ? (
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{formatDuration(entry.outcome.durationMs)}</Text>
        ) : null}
      </View>
    </View>
  );
}
