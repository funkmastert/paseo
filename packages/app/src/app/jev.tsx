import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { JevDashboardScreen } from "@/screens/jev-dashboard-screen";

export default function JevDashboardRoute() {
  const params = useLocalSearchParams<{ host?: string; agent?: string }>();
  const serverId = typeof params.host === "string" ? params.host : undefined;
  const agentId = typeof params.agent === "string" ? params.agent : undefined;

  return (
    <HostRouteBootstrapBoundary>
      <JevDashboardScreen initialServerId={serverId} initialAgentId={agentId} />
    </HostRouteBootstrapBoundary>
  );
}
