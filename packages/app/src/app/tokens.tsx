import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { TokenUsageScreen } from "@/token-usage/token-usage-screen";

export default function TokenUsageRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <TokenUsageScreen />
    </HostRouteBootstrapBoundary>
  );
}
