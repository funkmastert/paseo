import { generateMessageId } from "@/types/stream";

export const NEW_WORKSPACE_DRAFT_KEY = "new-workspace";
const NEW_WORKSPACE_FORK_DRAFT_PREFIX = `${NEW_WORKSPACE_DRAFT_KEY}:draft:`;

const DRAFT_ID_PREFIX = "draft_";

export function generateDraftId(): string {
  return `${DRAFT_ID_PREFIX}${generateMessageId()}`;
}

/** A draft tab's id, which stands in for an agent id until the daemon creates the agent. */
export function isDraftId(id: string): boolean {
  return id.startsWith(DRAFT_ID_PREFIX);
}

export function buildNewWorkspaceDraftKey(draftId?: string): string {
  const explicitDraftId = draftId?.trim();
  if (explicitDraftId) {
    return `${NEW_WORKSPACE_FORK_DRAFT_PREFIX}${explicitDraftId}`;
  }
  return NEW_WORKSPACE_DRAFT_KEY;
}

export function isLegacyNewWorkspaceDraftKey(draftKey: string): boolean {
  return (
    draftKey.startsWith(`${NEW_WORKSPACE_DRAFT_KEY}:`) &&
    !draftKey.startsWith(NEW_WORKSPACE_FORK_DRAFT_PREFIX)
  );
}

export function buildDraftStoreKey(input: {
  serverId: string;
  agentId: string;
  draftId?: string | null;
}): string {
  const serverId = input.serverId.trim();
  const explicitDraftId = input.draftId?.trim();
  if (explicitDraftId) {
    return `draft:${serverId}:${explicitDraftId}`;
  }
  return `agent:${serverId}:${input.agentId.trim()}`;
}
