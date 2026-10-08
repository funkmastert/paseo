import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { KnowledgeBaseScreen } from "@/screens/knowledge-base-screen";
import { parseKnowledgeNoteRouteId } from "@/utils/host-routes";

export default function KnowledgeBaseRoute() {
  const params = useLocalSearchParams<{ host?: string; note?: string }>();
  const serverId = typeof params.host === "string" ? params.host : null;
  const selectedPath =
    typeof params.note === "string" ? parseKnowledgeNoteRouteId(params.note) : null;

  return (
    <HostRouteBootstrapBoundary>
      <KnowledgeBaseScreen
        initialServerId={serverId}
        selectedPath={selectedPath}
        selectionParam="note"
      />
    </HostRouteBootstrapBoundary>
  );
}
