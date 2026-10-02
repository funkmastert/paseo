import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { InboxScreen } from "@/screens/inbox-screen";

export default function InboxRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <InboxScreen />
    </HostRouteBootstrapBoundary>
  );
}
