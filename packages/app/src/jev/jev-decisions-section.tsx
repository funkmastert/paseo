import { useCallback, useMemo } from "react";
import { router } from "expo-router";
import { buildJevDashboardRoute } from "@/utils/host-routes";
import { JevDecisionsList } from "./jev-decisions-list";
import { buildJevDecisionsView } from "./jev-decisions-model";
import { useAgentJevDecisions } from "./use-agent-jev-decisions";

/** The agent's JEV decisions under the context breakdown, fetched while the popover is open. */
export function JevDecisionsSection({
  serverId,
  agentId,
  enabled,
}: {
  serverId: string | null | undefined;
  agentId: string | null | undefined;
  enabled: boolean;
}) {
  const { data } = useAgentJevDecisions(serverId, agentId, { enabled });
  const view = useMemo(
    () => buildJevDecisionsView(data?.decisions ?? [], data?.status ?? null),
    [data],
  );
  const openAllActivity = useCallback(() => {
    if (!serverId || !agentId) return;
    router.push(buildJevDashboardRoute(serverId, agentId));
  }, [serverId, agentId]);
  if (view.lines.length === 0) return null;
  return <JevDecisionsList view={view} onOpenAllActivity={openAllActivity} />;
}
