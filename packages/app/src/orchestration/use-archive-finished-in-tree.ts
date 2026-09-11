import { useCallback, useState } from "react";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { runArchiveFinished, type ArchiveFinishedStatus } from "@/subagents/archive-finished";
import { groupAgentsByParent, toOrchestrationArchiveRow } from "./orchestration-panel-model";

export interface UseArchiveFinishedInTreeInput {
  serverId: string;
  /** Every finished agent across every root's subtree — see `collectFinishedAgentsAcrossRoots`. */
  agents: readonly Agent[];
}

export interface ArchiveFinishedInTreeCapability {
  eligibleCount: number;
  status: ArchiveFinishedStatus;
  archiveFinished: () => Promise<void>;
}

/**
 * The orchestration panel's "Archive finished" bulk action. Drives the same archive loop the
 * subagents track uses (`runArchiveFinished`), one call per immediate-parent group — see
 * `groupAgentsByParent` for why grouping is required here and not in the track's single-parent
 * case.
 */
export function useArchiveFinishedInTree({
  serverId,
  agents,
}: UseArchiveFinishedInTreeInput): ArchiveFinishedInTreeCapability {
  const { archiveAgent } = useArchiveAgent();
  const [status, setStatus] = useState<ArchiveFinishedStatus>({ kind: "idle" });

  const archiveFinished = useCallback(async () => {
    if (status.kind === "archiving" || agents.length === 0) {
      return;
    }
    const total = agents.length;
    let completed = 0;
    let failed = 0;
    setStatus({ kind: "archiving", completedCount: 0, totalCount: total });

    for (const [parentAgentId, groupAgents] of groupAgentsByParent(agents)) {
      const rows = groupAgents.map(toOrchestrationArchiveRow);
      const completedBeforeGroup = completed;
      const { outcome } = await runArchiveFinished(
        rows,
        {
          parentAgentId,
          getManagedSubagent: (id) => useSessionStore.getState().sessions[serverId]?.agents.get(id),
          archiveManagedSubagent: (id) => archiveAgent({ serverId, agentId: id }),
          // The orchestration tree is built from managed agents only (see select.ts) — it never
          // carries provider subagents, so this branch of the shared loop is never exercised.
          dismissProviderSubagents: () => undefined,
        },
        (groupCompleted) => {
          setStatus({
            kind: "archiving",
            completedCount: completedBeforeGroup + groupCompleted,
            totalCount: total,
          });
        },
      );
      completed += rows.length;
      failed += outcome.failures.length;
    }

    setStatus(
      failed > 0 ? { kind: "failed", failedCount: failed, totalCount: total } : { kind: "idle" },
    );
  }, [agents, archiveAgent, serverId, status.kind]);

  return { eligibleCount: agents.length, status, archiveFinished };
}
