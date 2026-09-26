import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { PinnedGridScreen } from "@/pinned-grid/pinned-grid-screen";

export default function PinnedGridRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <PinnedGridScreen />
    </HostRouteBootstrapBoundary>
  );
}
