import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { InsightsScreen } from "@/screens/insights-screen";

export default function InsightsRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <InsightsScreen />
    </HostRouteBootstrapBoundary>
  );
}
