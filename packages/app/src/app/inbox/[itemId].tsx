import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { InboxItemScreen } from "@/screens/inbox-item-screen";

export default function InboxItemRoute() {
  const params = useLocalSearchParams<{ itemId?: string; serverId?: string }>();
  const itemId = typeof params.itemId === "string" ? params.itemId : "";
  const serverId = typeof params.serverId === "string" ? params.serverId : "";

  if (!itemId || !serverId) {
    return null;
  }

  return (
    <HostRouteBootstrapBoundary>
      <InboxItemScreen serverId={serverId} itemId={itemId} />
    </HostRouteBootstrapBoundary>
  );
}
