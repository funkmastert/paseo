import { useCallback } from "react";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { CompactionEpisode } from "./use-compaction-episodes";

// Compactions are rare; a 15s poll (the JEV marker's cadence) is more than enough, and matches
// the cost of `use-agent-jev-decisions.ts`'s own poll for the same timeline.
export const AGENT_COMPACTION_EPISODES_POLL_MS = 15 * 1000;
const AGENT_COMPACTION_EPISODES_STALE_TIME_MS = 5 * 1000;
/** Comfortably above how many compactions one agent accrues before this screen is revisited. */
const AGENT_COMPACTION_EPISODES_LIMIT = 100;
/** One empty list for every render without data: a fresh `[]` would re-render the stream's rows. */
const NO_EPISODES: CompactionEpisode[] = [];

export function agentCompactionEpisodesQueryKey(
  serverId: string | null | undefined,
  agentId: string | null | undefined,
) {
  return ["agentCompactionEpisodes", serverId ?? "", agentId ?? ""] as const;
}

/**
 * One agent's compaction episodes, newest first, for the timeline's compaction marker to join
 * against by timestamp (docs/insights.md). Gated on `server_info.features.compactionLedger`.
 */
export function useAgentCompactionEpisodes(
  serverId: string | null | undefined,
  agentId: string | null | undefined,
  options: { enabled?: boolean } = {},
): { episodes: CompactionEpisode[]; isSupported: boolean } {
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const isSupported = useHostFeature(serverId, "compactionLedger");
  const enabled = Boolean(
    (options.enabled ?? true) && serverId && agentId && client && isConnected && isSupported,
  );

  const queryFn = useCallback(async (): Promise<CompactionEpisode[]> => {
    // Unreachable in practice: the query is only enabled while a client and an agent exist.
    if (!client || !agentId) {
      throw new Error("compaction episodes requested without a host client");
    }
    const payload = await client.compactionEpisodesList({
      range: "all",
      agentId,
      limit: AGENT_COMPACTION_EPISODES_LIMIT,
    });
    return payload.episodes;
  }, [agentId, client]);

  const query = useFetchQuery({
    queryKey: agentCompactionEpisodesQueryKey(serverId, agentId),
    dataShape: "value",
    staleTimeMs: AGENT_COMPACTION_EPISODES_STALE_TIME_MS,
    queryFn,
    enabled,
    refetchInterval: AGENT_COMPACTION_EPISODES_POLL_MS,
  });

  return { episodes: enabled ? (query.data ?? NO_EPISODES) : NO_EPISODES, isSupported };
}
