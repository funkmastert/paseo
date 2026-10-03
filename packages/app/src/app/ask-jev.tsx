import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { AskJevScreen } from "@/screens/ask-jev-screen";

export default function AskJevRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <AskJevScreen />
    </HostRouteBootstrapBoundary>
  );
}
