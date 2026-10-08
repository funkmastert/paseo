import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { KnowledgeBaseScreen } from "@/screens/knowledge-base-screen";
import { parseKnowledgeNoteRouteId } from "@/utils/host-routes";

export default function KnowledgeNoteRoute() {
  const params = useLocalSearchParams<{ noteId: string; host?: string }>();
  const serverId = typeof params.host === "string" ? params.host : null;
  // A segment that is not a note id still opens the note view, which answers "Note not found".
  const selectedPath = parseKnowledgeNoteRouteId(params.noteId) ?? params.noteId;

  return (
    <HostRouteBootstrapBoundary>
      <KnowledgeBaseScreen
        initialServerId={serverId}
        selectedPath={selectedPath}
        selectionParam="noteId"
      />
    </HostRouteBootstrapBoundary>
  );
}
