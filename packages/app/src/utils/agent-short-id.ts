/** Matches the server's `shortId` convention (`agent.id.slice(0, 7)` in agent-projections.ts). */
export function getAgentShortId(agentId: string): string {
  return agentId.slice(0, 7);
}
