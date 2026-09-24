import { ContextUsageBreakdown } from "./context-usage-breakdown";
import type { ContextMeterThresholds, ContextMeterTone } from "./context-meter-model";
import { useAgentContextUsage } from "./use-agent-context-usage";

export function ContextUsageBreakdownSection({
  serverId,
  agentId,
  enabled,
  usedTokens,
  tone,
  thresholds,
}: {
  serverId: string | null | undefined;
  agentId: string | null | undefined;
  enabled: boolean;
  usedTokens: number;
  tone: ContextMeterTone;
  thresholds: ContextMeterThresholds;
}) {
  const { data, isSupported, isLoading } = useAgentContextUsage(serverId, agentId, { enabled });
  return (
    <ContextUsageBreakdown
      payload={data}
      isSupported={isSupported}
      isLoading={isLoading}
      usedTokens={usedTokens}
      tone={tone}
      thresholds={thresholds}
    />
  );
}
