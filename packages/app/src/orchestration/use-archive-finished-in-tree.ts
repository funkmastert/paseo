import { useCallback, useEffect, useRef, useState } from "react";
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
 * A stable key for "which agents are currently eligible to archive" — mirrors
 * `eligibleSignature` in `subagents/archive-finished.ts`. Used to detect that the eligible set
 * has changed while `status` is `"failed"`, so a stuck failure can reset instead of latching
 * forever (see the reset effect in the hook below).
 */
function eligibleAgentsSignature(agents: readonly Agent[]): string {
  return [...new Set(agents.map((agent) => agent.id))].sort().join("\0");
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
  const failedSignatureRef = useRef<string | null>(null);
  const signature = eligibleAgentsSignature(agents);

  // Mirrors the reset effect in `subagents/archive-finished.ts`'s `setRows`: once `status` is
  // `"failed"`, it otherwise never clears. If the eligible set changes shape (new agents finish,
  // or the failed ones get archived/cleared elsewhere), drop back to idle so a retry isn't
  // blocked by a stale failure.
  useEffect(() => {
    if (status.kind === "failed" && failedSignatureRef.current !== signature) {
      failedSignatureRef.current = null;
      setStatus({ kind: "idle" });
    }
  }, [signature, status.kind]);

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

    if (failed > 0) {
      failedSignatureRef.current = signature;
      setStatus({ kind: "failed", failedCount: failed, totalCount: total });
    } else {
      failedSignatureRef.current = null;
      setStatus({ kind: "idle" });
    }
  }, [agents, archiveAgent, serverId, signature, status.kind]);

  return { eligibleCount: agents.length, status, archiveFinished };
}
