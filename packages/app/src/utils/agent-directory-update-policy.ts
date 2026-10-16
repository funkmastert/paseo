import equal from "fast-deep-equal";
import type { AgentUsage } from "@getpaseo/protocol/agent-types";

interface AgentUpdateValue {
  updatedAt: Date | string;
  lastUsage?: AgentUsage;
}

function timestamp(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

/**
 * Decides which object the agents Map keeps for an incoming live update. Streaming-only fields
 * (usage, activity summary, MCP statuses) arrive without a newer `updatedAt`, so "same or newer
 * timestamp" alone would replace the object on every tick; an update that changes nothing keeps
 * the previous identity so the Map, every selector, and every memoized row stay put.
 */
export function acceptAgentDirectoryUpdate<T extends AgentUpdateValue>(
  current: T | undefined,
  incoming: T,
): T {
  if (!current) return incoming;
  if (timestamp(incoming.updatedAt) >= timestamp(current.updatedAt)) {
    return equal(incoming, current) ? current : incoming;
  }
  if (incoming.lastUsage === undefined) return current;
  if (equal(incoming.lastUsage, current.lastUsage)) return current;
  return { ...current, lastUsage: incoming.lastUsage };
}
