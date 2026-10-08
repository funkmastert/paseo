import {
  JEV_CALL_LABEL,
  JEV_SPAWN_LABEL,
  TASK_CLASS_SOURCE_LABEL,
} from "@getpaseo/protocol/agent-labels";

import type { JevSavingsSink } from "./contract.js";
import { JevSavingsLedger, savingsIdForCall } from "./savings.js";

/**
 * Feature 2's savings record (docs/jev.md, "Savings", "A durable record for the classifier"). The
 * role router writes `paseo.jev-spawn` beside `paseo.jev-call` on a create JEV answered or
 * shadowed; the daemon records the involvement when it first sees the agent, and settles it with
 * the child's weighted tokens when the child closes, or after 24 hours.
 */

const HOUR_MS = 60 * 60_000;
const SETTLE_AFTER_MS = 24 * HOUR_MS;
const SWEEP_INTERVAL_MS = HOUR_MS;
const TASK_CLASS_LABEL = "paseo.task-class";

export interface JevSpawnLabel {
  baseClass: string | null;
  baseModel: string | null;
  wouldClass: string | null;
  wouldModel: string | null;
  move: "down" | "up" | "none";
  applied: boolean;
}

function decodePart(part: string): string | null {
  const value = decodeURIComponent(part);
  return value === "-" || value.length === 0 ? null : value;
}

function classAndModel(value: string | undefined): [string | null, string | null] | null {
  if (value === undefined) return null;
  const slash = value.indexOf("/");
  if (slash < 0) return null;
  try {
    return [decodePart(value.slice(0, slash)), decodePart(value.slice(slash + 1))];
  } catch {
    return null;
  }
}

/** `v1;base=standard/claude-sonnet-5;would=mechanical/claude-haiku-4-5;move=down;applied=0`. */
export function parseJevSpawnLabel(value: string | null | undefined): JevSpawnLabel | null {
  if (typeof value !== "string") return null;
  const [version, ...pairs] = value.split(";");
  if (version !== "v1") return null;
  const fields = new Map(
    pairs.map((pair) => {
      const equals = pair.indexOf("=");
      return [pair.slice(0, equals), pair.slice(equals + 1)] as const;
    }),
  );
  const base = classAndModel(fields.get("base"));
  const would = classAndModel(fields.get("would"));
  const move = fields.get("move");
  if (!base || !would || (move !== "down" && move !== "up" && move !== "none")) return null;
  return {
    baseClass: base[0],
    baseModel: base[1],
    wouldClass: would[0],
    wouldModel: would[1],
    move,
    applied: fields.get("applied") === "1",
  };
}

/** What the recorder reads off an agent. */
export interface SpawnHintAgentView {
  id: string;
  labels: Readonly<Record<string, string>>;
  workspaceId: string | null;
  createdAtMs: number;
  closed: boolean;
  /** Weighted spend-equivalent tokens (docs/token-burn.md). Restarts at 0 when loaded from disk. */
  totalTokens: number | null;
  /** The model it runs: the runtime's, else the configured one. */
  model: string | null;
}

export interface SpawnHintSavingsRecorder {
  onAgent(agent: SpawnHintAgentView): void;
  /** Settles children still open 24 hours after their record. */
  sweep(): void;
}

export function createSpawnHintSavingsRecorder(options: {
  savings: JevSavingsSink;
  /** Agents created before this ran were loaded from disk: their `totalTokens` restarted at 0. */
  startedAtMs: number;
  readAgent: (agentId: string) => SpawnHintAgentView | null;
  now?: () => number;
}): SpawnHintSavingsRecorder {
  const { savings } = options;
  const now = options.now ?? Date.now;
  const createdThisRun = (agent: SpawnHintAgentView) => agent.createdAtMs >= options.startedAtMs;

  function settleChild(savingsId: string, agent: SpawnHintAgentView | null): void {
    const facts = savings instanceof JevSavingsLedger ? savings.factsOf(savingsId) : null;
    if (facts && typeof facts["agentTotalTokens"] === "number") return;
    if (agent && createdThisRun(agent) && agent.totalTokens !== null) {
      // The model is read again here: `runtimeInfo.model` arrives after the first state, and a
      // failover or an alias can change it.
      savings.settle(savingsId, {
        agentTotalTokens: agent.totalTokens,
        ...(agent.model ? { runningModel: agent.model } : {}),
      });
    } else {
      savings.settle(savingsId, { partial: true });
    }
  }

  return {
    onAgent(agent) {
      try {
        const callId = agent.labels[JEV_CALL_LABEL];
        const spawn = parseJevSpawnLabel(agent.labels[JEV_SPAWN_LABEL]);
        if (!callId || !spawn) return;
        let savingsId = savingsIdForCall(savings, callId);
        if (!savingsId && createdThisRun(agent)) {
          savingsId =
            savings.record({
              feature: "spawnHint",
              callSite: "classifier.spawn-hint",
              callId,
              agentId: agent.id,
              workspaceId: agent.workspaceId,
              involvement: "What class of work is this create?",
              decision: {
                did: `${agent.labels[TASK_CLASS_LABEL] ?? "standard"} on ${agent.model ?? "?"}`,
                wouldBe: `${spawn.wouldClass ?? "standard"} on ${spawn.wouldModel ?? "?"}`,
                changed: spawn.applied && spawn.move !== "none",
              },
              facts: {
                baseClass: spawn.baseClass,
                baseModel: spawn.baseModel,
                wouldClass: spawn.wouldClass,
                wouldModel: spawn.wouldModel,
                runningClass: agent.labels[TASK_CLASS_LABEL] ?? null,
                runningModel: agent.model,
                move: spawn.move,
                applied: spawn.applied,
                // The declared-label audit (docs/jev.md, "Auditing a declared label"): kept out of
                // the go-live rule's evidence counters, which read "this child's class was never
                // declared" (savings-formulas.ts).
                ...(agent.labels[TASK_CLASS_SOURCE_LABEL] === "declared"
                  ? { declaredAudit: true }
                  : {}),
              },
              pending: true,
            }) || null;
        }
        if (savingsId && agent.closed) settleChild(savingsId, agent);
      } catch {
        // Never breaks the agent manager's subscribers.
      }
    },
    sweep() {
      try {
        if (!(savings instanceof JevSavingsLedger)) return;
        const nowMs = now();
        for (const record of savings.pendingRecords("spawnHint")) {
          if (nowMs - record.atMs < SETTLE_AFTER_MS) continue;
          settleChild(record.id, record.agentId ? options.readAgent(record.agentId) : null);
        }
      } catch {
        // The next sweep tries again.
      }
    },
  };
}

/** The shape of `ManagedAgent` this reads, so the recorder needs no agent manager import. */
interface ManagedAgentLike {
  id: string;
  labels: Record<string, string>;
  workspaceId?: string | undefined;
  createdAt: Date;
  lifecycle?: string;
  totalTokens?: number;
  config: { model?: string | null };
  runtimeInfo?: { model?: string | null } | null;
}

export function spawnHintAgentView(agent: ManagedAgentLike): SpawnHintAgentView {
  return {
    id: agent.id,
    labels: agent.labels,
    workspaceId: agent.workspaceId ?? null,
    createdAtMs: agent.createdAt.getTime(),
    closed: agent.lifecycle === "closed",
    totalTokens: agent.totalTokens ?? null,
    model: agent.runtimeInfo?.model ?? agent.config.model ?? null,
  };
}

/**
 * Wires the recorder to the agent manager: every `agent_state`, and an hourly sweep. Never touches
 * `setAgentArchivedCallback`, which has one owner.
 */
export function startSpawnHintSavings(options: {
  savings: JevSavingsSink;
  agentManager: {
    subscribe(
      callback: (event: { type: string; agent?: ManagedAgentLike }) => void,
      options?: { replayState?: boolean },
    ): () => void;
    getAgent(agentId: string): ManagedAgentLike | null | undefined;
  };
}): { stop(): void } {
  const recorder = createSpawnHintSavingsRecorder({
    savings: options.savings,
    startedAtMs: Date.now(),
    readAgent: (agentId) => {
      const agent = options.agentManager.getAgent(agentId);
      return agent ? spawnHintAgentView(agent) : null;
    },
  });
  const unsubscribe = options.agentManager.subscribe(
    (event) => {
      if (event.type === "agent_state" && event.agent)
        recorder.onAgent(spawnHintAgentView(event.agent));
    },
    { replayState: false },
  );
  const timer = setInterval(() => recorder.sweep(), SWEEP_INTERVAL_MS);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      unsubscribe();
    },
  };
}
