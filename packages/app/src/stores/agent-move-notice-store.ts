import { create } from "zustand";

/** The agent a moved conversation went to, waiting for the note to name its account. */
export interface AgentMoveNotice {
  id: number;
  serverId: string;
  agentId: string;
}

interface AgentMoveNoticeState {
  notice: AgentMoveNotice | null;
}

export const useAgentMoveNoticeStore = create<AgentMoveNoticeState>(() => ({ notice: null }));

let nextNoticeId = 0;

/** Raises the one-line "Moved to <account>" note (`AgentMoveNoticeToast`). Latest wins. */
export function announceAgentMove(input: { serverId: string; agentId: string }): void {
  nextNoticeId += 1;
  useAgentMoveNoticeStore.setState({ notice: { id: nextNoticeId, ...input } });
}
