/**
 * Coordination tools: the questions an agent in a fleet has to answer about the fleet without
 * guessing, and the one way to talk to several agents at once.
 *
 *   whoami                   who I am: id, account, running model, parent, what the classifier
 *                            decided for me, whether I was moved, my budget
 *   list_peers               what my siblings and children are doing right now
 *   broadcast_agent_prompt   one message to a label-selected set of my children or siblings,
 *                            without turning it into a paid turn for every one of them
 *   search_agent_transcript  grep an agent's (or its whole descendant tree's) own provider
 *                            transcript, with an honest coverage report, instead of loading its
 *                            full timeline
 *   queue_*                  the work queue (OR-A1): create, claim, update, hand off, list and
 *                            show owned work items. Registered only when coordination is enabled.
 *                            See docs/work-queue.md.
 *
 * Why these exist: agents repeatedly got their own identity wrong (which account they ran on,
 * who their parent was, which model they actually had), and one reported its predecessor's id as
 * its own after being moved. `whoami` reads the answers from the daemon instead of letting the
 * agent infer them. It reports what the classifier decided and never re-derives it — the
 * classifier (plugins/claude-account-pool/server/classifier.ts) is the only authority on role,
 * model, account and tools, so this file reads the labels it stamped and stops there.
 *
 * ## Adding a tool
 *
 * One place: write a `defineCoordinationTool({...})` and append it to `COORDINATION_TOOLS` at the
 * bottom. `registerCoordinationTools` (the single line in paseo-tools.ts) registers everything in
 * that array, and every handler receives the same `CoordinationToolHost`, so a new tool needs no
 * change to paseo-tools.ts. Put anything a test should reach without a daemon in a pure exported
 * function (`buildWhoami`, `selectBroadcastTargets`, `planBroadcastDelivery`) and keep the
 * handler to wiring: load, call the pure function, deliver, shape the result.
 *
 * ## Output size
 *
 * Every tool here is compact by default and takes `full: true` for the rest (OR-H4). A leader
 * pays for every byte of every call, so a default that is only right for a debugging session is
 * the wrong default.
 *
 * See docs/plans/2026-09-23-001-feat-openrig-port-plan.md (OR-E4, OR-E1, OR-H4).
 */

import { z } from "zod";
import type { Logger } from "pino";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import { ensureValidJson } from "../../json-utils.js";
import type { AgentManager, ManagedAgent } from "../agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent-storage.js";
import {
  formatSystemNotificationPrompt,
  sendPromptToAgent,
  setupFinishNotification,
} from "../agent-prompt.js";
import { SPEND_BUDGET_LABEL } from "../spend-governor.js";
import {
  ACCOUNT_FAILOVER_MIGRATED_TO_LABEL,
  HANDOFF_FROM_LABEL,
} from "../account-failover-detector.js";
import { searchAgentTranscript } from "../transcript-search/index.js";
import type { PaseoToolConfig, PaseoToolExecutionContext, PaseoToolResult } from "./types.js";
import {
  HUMAN_WORK_ITEM_OWNER,
  WORK_ITEM_CLOSURE_REASONS,
  WorkItemStateSchema,
  type WorkItem,
  type WorkItemTransition,
} from "@getpaseo/protocol/coordination/queue-schemas";
import type { CoordinationRuntime } from "../../coordination/runtime.js";

// The classifier's label vocabulary. Mirrored here rather than imported: the classifier lives in
// a plugin that the daemon core must not depend on (docs/plugins.md), and these strings are the
// contract between them. Reading a label is not re-deriving what the classifier decided.
const AGENT_ROLE_LABEL = "paseo.agent-role";
const AGENT_TYPE_LABEL = "paseo.agent-type";
const TASK_CLASS_LABEL = "paseo.task-class";
const TOOLS_DENIED_LABEL = "paseo.tools-denied";
const MODEL_OVERRIDDEN_LABEL = "paseo.model-overridden-by-policy";
const MODEL_UNADVERTISED_LABEL = "paseo.model-unadvertised";

// ---------------------------------------------------------------------------------------------
// Tool plumbing
// ---------------------------------------------------------------------------------------------

export interface CoordinationToolHost {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  /** Absent for a top-level session (a human, the CLI, the app). Identity tools need it. */
  callerAgentId?: string;
  logger: Logger;
  /** Present only when coordination is enabled; the queue tools register only then. */
  coordination?: Pick<CoordinationRuntime, "require">;
}

export interface RegisterCoordinationToolsOptions extends CoordinationToolHost {
  registerTool: (
    name: string,
    config: PaseoToolConfig,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tool inputs are validated by the catalog before execution.
    handler: (input: any, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>,
  ) => void;
}

interface CoordinationToolDefinition {
  name: string;
  config: PaseoToolConfig;
  handler: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Validated by the catalog; each definition types its own input.
    input: any,
    host: CoordinationToolHost,
    context: PaseoToolExecutionContext,
  ) => Promise<PaseoToolResult>;
}

/** Types `input` from the tool's own zod shape, so a handler never restates it. */
function defineCoordinationTool<Shape extends z.ZodRawShape>(definition: {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  handler: (
    input: z.infer<z.ZodObject<Shape>>,
    host: CoordinationToolHost,
    context: PaseoToolExecutionContext,
  ) => Promise<PaseoToolResult>;
}): CoordinationToolDefinition {
  return {
    name: definition.name,
    config: {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.inputSchema,
    },
    handler: definition.handler,
  };
}

function toResult(payload: unknown): PaseoToolResult {
  return { content: [], structuredContent: ensureValidJson(payload) };
}

function requireCaller(host: CoordinationToolHost, tool: string): string {
  if (!host.callerAgentId) {
    throw new Error(
      `${tool} is only available inside an agent session: it answers for the agent that calls it, ` +
        "and this session has no agent id.",
    );
  }
  return host.callerAgentId;
}

// ---------------------------------------------------------------------------------------------
// Fleet view: one shape for a live agent and a stored one
// ---------------------------------------------------------------------------------------------

export interface FleetEntry {
  id: string;
  title: string | null;
  /** Live lifecycle when the agent is loaded, else the last status the record stored. */
  status: string;
  /** False for an agent that is only a stored record (not loaded in the daemon). */
  live: boolean;
  provider: string;
  cwd: string;
  workspaceId: string | null;
  labels: Record<string, string>;
  /** What the provider reports it is running; null until a session has said. */
  runningModel: string | null;
  /** What the agent was configured with. */
  configuredModel: string | null;
  activity: string | null;
  totalTokens: number | null;
  archived: boolean;
  requiresAttention: boolean;
  pendingPermissionCount: number;
  currentModeId: string | null;
  sessionId: string | null;
}

function fromRecord(record: StoredAgentRecord): FleetEntry {
  return {
    id: record.id,
    title: record.title ?? null,
    status: record.lastStatus,
    live: false,
    provider: record.provider,
    cwd: record.cwd,
    workspaceId: record.workspaceId ?? null,
    labels: record.labels,
    runningModel: record.runtimeInfo?.model ?? null,
    configuredModel: record.config?.model ?? null,
    activity: null,
    totalTokens: null,
    archived: Boolean(record.archivedAt),
    requiresAttention: record.requiresAttention ?? false,
    pendingPermissionCount: 0,
    currentModeId: record.lastModeId ?? null,
    sessionId: record.persistence?.sessionId ?? record.runtimeInfo?.sessionId ?? null,
  };
}

function overlayLive(base: FleetEntry | undefined, agent: ManagedAgent): FleetEntry {
  return {
    id: agent.id,
    title: base?.title ?? null,
    status: agent.lifecycle,
    live: true,
    provider: agent.provider,
    cwd: agent.cwd,
    workspaceId: agent.workspaceId ?? null,
    labels: agent.labels,
    runningModel: agent.runtimeInfo?.model ?? null,
    configuredModel: agent.config.model ?? null,
    activity: agent.lastActivitySummary ?? null,
    totalTokens: agent.totalTokens ?? null,
    archived: base?.archived ?? false,
    requiresAttention: agent.attention.requiresAttention,
    pendingPermissionCount: agent.pendingPermissions.size,
    currentModeId: agent.currentModeId,
    sessionId: agent.persistence?.sessionId ?? agent.runtimeInfo?.sessionId ?? null,
  };
}

/** Every non-internal agent, keyed by id. Live state wins over the stored record. */
export async function loadFleet(
  host: Pick<CoordinationToolHost, "agentManager" | "agentStorage">,
): Promise<Map<string, FleetEntry>> {
  const fleet = new Map<string, FleetEntry>();
  for (const record of await host.agentStorage.list()) {
    if (!record.internal) fleet.set(record.id, fromRecord(record));
  }
  for (const agent of host.agentManager.listAgents()) {
    fleet.set(agent.id, overlayLive(fleet.get(agent.id), agent));
  }
  return fleet;
}

function childrenOf(fleet: ReadonlyMap<string, FleetEntry>, parentId: string): FleetEntry[] {
  return [...fleet.values()].filter(
    (entry) => !entry.archived && getParentAgentIdFromLabels(entry.labels) === parentId,
  );
}

function siblingsOf(fleet: ReadonlyMap<string, FleetEntry>, self: FleetEntry): FleetEntry[] {
  const parentId = getParentAgentIdFromLabels(self.labels);
  if (!parentId) return [];
  return childrenOf(fleet, parentId).filter((entry) => entry.id !== self.id);
}

function countByState(entries: readonly FleetEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  return counts;
}

function matchesLabels(entry: FleetEntry, selector: Record<string, string> | undefined): boolean {
  if (!selector) return true;
  return Object.entries(selector).every(([key, value]) => entry.labels[key] === value);
}

function truncate(text: string | null, max: number): string | null {
  if (text === null) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---------------------------------------------------------------------------------------------
// whoami
// ---------------------------------------------------------------------------------------------

const COMPACT_ROW_LIMIT = 25;
const FULL_ROW_LIMIT = 100;

export interface WhoamiRow {
  id: string;
  title: string | null;
  status: string;
  activity?: string | null;
  provider?: string;
  model?: string | null;
}

function toWhoamiRow(entry: FleetEntry, full: boolean): WhoamiRow {
  return {
    id: entry.id,
    title: entry.title,
    status: entry.status,
    ...(full
      ? {
          activity: truncate(entry.activity, 160),
          provider: entry.provider,
          model: entry.runningModel ?? entry.configuredModel,
        }
      : {}),
  };
}

function parseBudget(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function splitDenied(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export interface BuildWhoamiInput {
  self: FleetEntry;
  fleet: ReadonlyMap<string, FleetEntry>;
  fanOutDenial: { budgetTokens: number; spentTokens: number } | null;
  full: boolean;
}

function whoamiWarnings(input: {
  self: FleetEntry;
  parentId: string | null;
  handoffFrom: string | null;
  migratedTo: string | null;
  predecessorParentId: string | null;
  modelDiverged: boolean;
}): string[] {
  const { self } = input;
  const warnings: string[] = [];
  if (input.migratedTo) {
    warnings.push(
      `You are a retired handle: account failover moved this conversation to ${input.migratedTo}. ` +
        "Do not continue work here; that agent is the live end.",
    );
  }
  if (!input.parentId && input.predecessorParentId) {
    warnings.push(
      `You have no parent label, but you continue ${input.handoffFrom}'s work and it was spawned by ` +
        `${input.predecessorParentId}. That agent will not be told when you finish. Tell it yourself, ` +
        "or ask whoever created you to set paseo.parent-agent-id.",
    );
  }
  if (input.modelDiverged) {
    warnings.push(
      `You are running ${self.runningModel}, not the ${self.configuredModel} you were configured with.`,
    );
  }
  return warnings;
}

/**
 * Pure. Everything here is read off the agent, its labels or the fleet. The classifier's role
 * decision is not recorded on the agent (only what it enforced is: the denied tools, an
 * overridden or unverified model), so `classifier.role` is the role the CALLER declared, and
 * says so, rather than a guess at what the classifier would have picked.
 */
export function buildWhoami(input: BuildWhoamiInput): Record<string, unknown> {
  const { self, fleet, full } = input;
  const rowLimit = full ? FULL_ROW_LIMIT : COMPACT_ROW_LIMIT;
  const parentId = getParentAgentIdFromLabels(self.labels);
  const parent = parentId ? fleet.get(parentId) : undefined;
  const handoffFrom = nonEmpty(self.labels[HANDOFF_FROM_LABEL]);
  const migratedTo = nonEmpty(self.labels[ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]);
  const predecessor = handoffFrom ? fleet.get(handoffFrom) : undefined;
  const predecessorParentId = predecessor ? getParentAgentIdFromLabels(predecessor.labels) : null;
  const children = childrenOf(fleet, self.id);
  const siblings = siblingsOf(fleet, self);
  const budgetTokens = parseBudget(self.labels[SPEND_BUDGET_LABEL]);
  const modelDiverged =
    self.runningModel !== null &&
    self.configuredModel !== null &&
    self.runningModel !== self.configuredModel;

  const warnings = whoamiWarnings({
    self,
    parentId,
    handoffFrom,
    migratedTo,
    predecessorParentId,
    modelDiverged,
  });

  return {
    // Your id is the one the daemon put in your tool URL. It survives account moves, so it is
    // not `predecessor.id`, and it is not the id in your title's "[MOVED → …]" prefix.
    id: self.id,
    title: self.title,
    status: self.status,
    account: {
      provider: self.provider,
      note: "The provider id names the account slot you run on.",
    },
    model: {
      running: self.runningModel,
      configured: self.configuredModel,
      diverged: modelDiverged,
    },
    parent: parentId
      ? { id: parentId, title: parent?.title ?? null, status: parent?.status ?? "unknown" }
      : null,
    predecessor: handoffFrom
      ? {
          id: handoffFrom,
          title: predecessor?.title ?? null,
          note: "An earlier agent whose conversation you continue. It is not you.",
        }
      : null,
    movedByFailover: Boolean(migratedTo || handoffFrom),
    retiredTo: migratedTo,
    classifier: {
      role: nonEmpty(self.labels[AGENT_ROLE_LABEL]),
      roleSource: "declared at create; the classifier's own pick is not stored on the agent",
      taskClass: nonEmpty(self.labels[TASK_CLASS_LABEL]),
      agentType: nonEmpty(self.labels[AGENT_TYPE_LABEL]),
      toolsDenied: splitDenied(self.labels[TOOLS_DENIED_LABEL]),
      modelOverriddenFrom: nonEmpty(self.labels[MODEL_OVERRIDDEN_LABEL]),
      modelUnverified: nonEmpty(self.labels[MODEL_UNADVERTISED_LABEL]),
    },
    budget: {
      budgetTokens,
      spentTokens: self.totalTokens,
      fanOutBlocked: input.fanOutDenial !== null,
    },
    children: {
      count: children.length,
      byState: countByState(children),
      agents: children.slice(0, rowLimit).map((entry) => toWhoamiRow(entry, full)),
    },
    peers: {
      count: siblings.length,
      byState: countByState(siblings),
      ...(full
        ? { agents: siblings.slice(0, rowLimit).map((entry) => toWhoamiRow(entry, true)) }
        : {}),
    },
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(full
      ? {
          cwd: self.cwd,
          workspaceId: self.workspaceId,
          modeId: self.currentModeId,
          sessionId: self.sessionId,
          labels: self.labels,
        }
      : {}),
  };
}

const whoamiTool = defineCoordinationTool({
  name: "whoami",
  title: "Who am I",
  description:
    "Ask the daemon who you are instead of guessing: your agent id, the account (provider) and model you " +
    "actually run, your parent, your children and peers with their state, what the classifier restricted " +
    "for you, whether you were moved between accounts or continue a predecessor, and your token budget. " +
    "Call this when you are unsure of your own identity, after a move, and before reporting your id to anyone. " +
    "Compact by default; full=true adds labels, cwd, and what each child and peer is doing.",
  inputSchema: {
    full: z
      .boolean()
      .optional()
      .describe("Include labels, cwd, session id and per-agent activity. Defaults to false."),
  },
  handler: async ({ full = false }, host) => {
    const callerId = requireCaller(host, "whoami");
    const fleet = await loadFleet(host);
    const self = fleet.get(callerId);
    if (!self) {
      throw new Error(`Agent ${callerId} is not known to the daemon`);
    }
    return toResult(
      buildWhoami({
        self,
        fleet,
        fanOutDenial: host.agentManager.getSpendFanOutDenial(callerId),
        full,
      }),
    );
  },
});

// ---------------------------------------------------------------------------------------------
// list_peers
// ---------------------------------------------------------------------------------------------

const PeerScopeSchema = z.enum(["children", "siblings"]);
type PeerScope = z.infer<typeof PeerScopeSchema>;

export function selectPeers(input: {
  fleet: ReadonlyMap<string, FleetEntry>;
  callerId: string;
  scope: PeerScope;
  labels?: Record<string, string>;
}): FleetEntry[] {
  const self = input.fleet.get(input.callerId);
  let candidates: FleetEntry[] = [];
  if (input.scope === "children") {
    candidates = childrenOf(input.fleet, input.callerId);
  } else if (self) {
    candidates = siblingsOf(input.fleet, self);
  }
  return candidates.filter((entry) => matchesLabels(entry, input.labels));
}

function toPeerRow(entry: FleetEntry, full: boolean): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: entry.id,
    title: entry.title,
    status: entry.status,
    activity: truncate(entry.activity, 160),
    model: entry.runningModel ?? entry.configuredModel,
    role: nonEmpty(entry.labels[AGENT_ROLE_LABEL]),
  };
  if (entry.requiresAttention) row.needsAttention = true;
  if (entry.pendingPermissionCount > 0) row.pendingPermissions = entry.pendingPermissionCount;
  if (full) Object.assign(row, { provider: entry.provider, cwd: entry.cwd, labels: entry.labels });
  return row;
}

const listPeersTool = defineCoordinationTool({
  name: "list_peers",
  title: "List my peers",
  description:
    "What your children or siblings are doing right now: state, current activity, model, role, whether " +
    "they need attention. Cheaper than list_agents, which lists the whole machine. Use it to decide who " +
    "to message instead of polling each agent.",
  inputSchema: {
    scope: PeerScopeSchema.optional().describe(
      "children (default): agents you spawned. siblings: agents your parent spawned.",
    ),
    labels: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Keep only agents carrying every one of these labels, e.g. paseo.agent-role=reviewer.",
      ),
    statuses: z
      .array(z.enum(["initializing", "idle", "running", "error", "closed"]))
      .optional()
      .describe("Keep only agents in these states."),
    full: z
      .boolean()
      .optional()
      .describe("Include cwd, provider and all labels. Defaults to false."),
  },
  handler: async ({ scope = "children", labels, statuses, full = false }, host) => {
    const callerId = requireCaller(host, "list_peers");
    const fleet = await loadFleet(host);
    const stateFilter = statuses && statuses.length > 0 ? new Set<string>(statuses) : null;
    const peers = selectPeers({ fleet, callerId, scope, labels }).filter(
      (entry) => !stateFilter || stateFilter.has(entry.status),
    );
    const limit = full ? FULL_ROW_LIMIT : COMPACT_ROW_LIMIT;
    return toResult({
      scope,
      count: peers.length,
      byState: countByState(peers),
      agents: peers.slice(0, limit).map((entry) => toPeerRow(entry, full)),
      ...(peers.length > limit ? { truncated: peers.length - limit } : {}),
    });
  },
});

// ---------------------------------------------------------------------------------------------
// broadcast_agent_prompt
// ---------------------------------------------------------------------------------------------

/** A broadcast that matches more agents than this is refused, not silently truncated. */
export const MAX_BROADCAST_TARGETS = 25;
export const DEFAULT_MAX_WAKES = 3;
const MAX_WAKES_CEILING = 10;

export type BroadcastPlan =
  /** Deliver into the turn the agent is already running. Costs no new turn. */
  | { action: "steer" }
  /** Start a turn on an idle agent. Costs a paid turn. Only planned when the caller opted in. */
  | { action: "wake" }
  | { action: "skip"; reason: string };

/**
 * Pure. Decides what a broadcast does for one recipient, from lifecycle state alone. A running
 * agent is already paying for its turn, so the message rides along. Everything else is skipped
 * unless the caller asked to wake idle agents, and even then only up to `wakesRemaining`.
 */
export function planBroadcastDelivery(input: {
  entry: Pick<FleetEntry, "status" | "live">;
  wakeIdle: boolean;
  wakesRemaining: number;
}): BroadcastPlan {
  const { entry } = input;
  if (!entry.live) {
    return { action: "skip", reason: "not loaded: a stored agent is not woken by a broadcast" };
  }
  switch (entry.status) {
    case "running":
      return { action: "steer" };
    case "idle":
      if (!input.wakeIdle) {
        return {
          action: "skip",
          reason: "idle: delivering would start a paid turn (set wakeIdle to allow it)",
        };
      }
      if (input.wakesRemaining <= 0) {
        return { action: "skip", reason: "idle: maxWakes reached" };
      }
      return { action: "wake" };
    case "initializing":
      return { action: "skip", reason: "initializing: not ready to receive a message" };
    case "error":
      return { action: "skip", reason: "error: the agent stopped on an error" };
    default:
      return { action: "skip", reason: `${entry.status}: the agent has no live session` };
  }
}

export function selectBroadcastTargets(input: {
  fleet: ReadonlyMap<string, FleetEntry>;
  callerId: string;
  scope: PeerScope;
  labels?: Record<string, string>;
}): FleetEntry[] {
  return selectPeers(input).filter((entry) => entry.id !== input.callerId);
}

type BroadcastOutcome = "steered" | "woken" | "skipped" | "failed";

interface BroadcastTargetResult {
  agentId: string;
  title: string | null;
  outcome: BroadcastOutcome;
  reason?: string;
}

const broadcastAgentPromptTool = defineCoordinationTool({
  name: "broadcast_agent_prompt",
  title: "Broadcast to my agents",
  description:
    "Send one message to your children (or siblings), optionally only those carrying given labels " +
    "(e.g. paseo.agent-role=reviewer). COST: a message to an idle agent starts a paid turn on that agent's " +
    "account, so by default this delivers only to agents that are already running (the message joins their " +
    "current turn and costs no extra turn) and SKIPS idle ones. Set wakeIdle=true to start turns on idle " +
    "agents; that is capped by maxWakes (default 3) and every woken agent bills a full turn. Stored, " +
    "closed, errored and initializing agents are never contacted. Matching more than " +
    `${MAX_BROADCAST_TARGETS} agents is refused, not truncated. Use dryRun=true to see who would receive ` +
    "it and what it would cost before sending. Prefer send_agent_prompt for one agent.",
  inputSchema: {
    prompt: z.string().trim().min(1).max(8000).describe("The message to deliver."),
    scope: PeerScopeSchema.optional().describe(
      "children (default): agents you spawned. siblings: agents your parent spawned.",
    ),
    labels: z
      .record(z.string(), z.string())
      .optional()
      .describe("Keep only agents carrying every one of these labels."),
    wakeIdle: z
      .boolean()
      .optional()
      .describe("Also start a turn on idle agents. Each one is a paid turn. Defaults to false."),
    maxWakes: z
      .number()
      .int()
      .min(1)
      .max(MAX_WAKES_CEILING)
      .optional()
      .describe(`Most idle agents to wake. Defaults to ${DEFAULT_MAX_WAKES}.`),
    dryRun: z
      .boolean()
      .optional()
      .describe("Report what would happen and send nothing. Defaults to false."),
  },
  handler: async (
    { prompt, scope = "children", labels, wakeIdle = false, maxWakes = DEFAULT_MAX_WAKES, dryRun },
    host,
  ) => {
    const callerId = requireCaller(host, "broadcast_agent_prompt");
    const fleet = await loadFleet(host);
    const targets = selectBroadcastTargets({ fleet, callerId, scope, labels });
    if (targets.length > MAX_BROADCAST_TARGETS) {
      throw new Error(
        `The selector matches ${targets.length} agents, over the ${MAX_BROADCAST_TARGETS} a broadcast ` +
          "may reach. Narrow it with labels, or message them individually. Nothing was sent.",
      );
    }

    const callerTitle = fleet.get(callerId)?.title ?? null;
    const envelope = formatSystemNotificationPrompt(
      `Broadcast from agent ${callerId}${callerTitle ? ` (${callerTitle})` : ""}:\n\n${prompt}`,
    );

    const results: BroadcastTargetResult[] = [];
    let wakesUsed = 0;
    for (const target of targets) {
      const plan = planBroadcastDelivery({
        entry: target,
        wakeIdle,
        wakesRemaining: maxWakes - wakesUsed,
      });
      const base = { agentId: target.id, title: target.title };
      if (plan.action === "skip") {
        results.push({ ...base, outcome: "skipped", reason: plan.reason });
        continue;
      }
      if (plan.action === "wake") wakesUsed += 1;
      if (dryRun) {
        results.push({
          ...base,
          outcome: plan.action === "steer" ? "steered" : "woken",
          reason: "dry run: not sent",
        });
        continue;
      }
      results.push({ ...base, ...(await deliver({ host, callerId, target, plan, envelope })) });
    }

    const count = (outcome: BroadcastOutcome) =>
      results.filter((result) => result.outcome === outcome).length;
    return toResult({
      dryRun: Boolean(dryRun),
      matched: targets.length,
      steered: count("steered"),
      woken: count("woken"),
      skipped: count("skipped"),
      failed: count("failed"),
      // What the caller is billed for: only a woken agent starts a turn.
      turnsStarted: dryRun ? 0 : count("woken"),
      results,
    });
  },
});

async function deliver(input: {
  host: CoordinationToolHost;
  callerId: string;
  target: FleetEntry;
  plan: Exclude<BroadcastPlan, { action: "skip" }>;
  envelope: string;
}): Promise<{ outcome: BroadcastOutcome; reason?: string }> {
  const { host, target, envelope } = input;
  try {
    if (input.plan.action === "steer") {
      // steerAgentRun never falls back: an agent whose turn ended, or whose provider cannot take
      // a message mid-turn, answers "unavailable" and is left alone. send_agent_prompt's steer
      // path would instead start a new turn or replace the running one.
      const result = await host.agentManager.steerAgentRun(target.id, envelope);
      return result.status === "accepted"
        ? { outcome: "steered" }
        : {
            outcome: "skipped",
            reason: "could not join the current turn (it ended, or the provider cannot steer)",
          };
    }

    // The state was read a moment ago; do not start a turn on an agent that is no longer idle.
    if (host.agentManager.getAgent(target.id)?.lifecycle !== "idle") {
      return { outcome: "skipped", reason: "no longer idle" };
    }
    await sendPromptToAgent({
      agentManager: host.agentManager,
      agentStorage: host.agentStorage,
      agentId: target.id,
      prompt: envelope,
      activeTurnBehavior: "steer",
      // A broadcast must never un-archive an agent to talk to it.
      unarchive: false,
      logger: host.logger,
    });
    // A woken agent produces something the caller asked for; tell the caller when it lands.
    setupFinishNotification({
      agentManager: host.agentManager,
      agentStorage: host.agentStorage,
      childAgentId: target.id,
      callerAgentId: input.callerId,
      logger: host.logger,
    });
    return { outcome: "woken" };
  } catch (error) {
    return { outcome: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------------------------
// search_agent_transcript
// ---------------------------------------------------------------------------------------------

const searchAgentTranscriptTool = defineCoordinationTool({
  name: "search_agent_transcript",
  title: "Search an agent's transcript",
  description:
    "Grep an agent's own provider transcript (Claude JSONL, Codex rollout) for a pattern, without " +
    "loading its whole timeline. Set tree=true to also search every descendant (its children, " +
    "their children, and so on). Literal substring match by default; set regex=true for a regular " +
    "expression, ignoreCase=true to fold case. Reports which backend ran (ripgrep, ripgrep running " +
    "as the Claude Code binary, or a Node fallback) and, per agent, whether it was actually " +
    "searched, had no transcript file, uses a provider this cannot read, was cut short by a cap, " +
    "or timed out (a regex on the Node fallback is killed after a deadline rather than risking the " +
    "daemon) — a 'not found' only ever means what it says, never a guess from a partial search. " +
    "Compact by default (fewer matches, shorter excerpts, total output capped); full=true raises " +
    "every cap.",
  inputSchema: {
    agentId: z
      .string()
      .min(1)
      .describe("Agent to search. Any agent id, not only your own children."),
    pattern: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("Literal text, or a regex when regex=true."),
    tree: z
      .boolean()
      .optional()
      .describe("Also search every descendant of agentId. Defaults to false."),
    regex: z
      .boolean()
      .optional()
      .describe("Treat pattern as a regular expression. Defaults to false."),
    ignoreCase: z.boolean().optional().describe("Case-insensitive match. Defaults to false."),
    full: z
      .boolean()
      .optional()
      .describe(
        "More matches per agent, longer excerpts, a larger total output cap. Defaults to false.",
      ),
  },
  handler: async ({ agentId, pattern, tree, regex, ignoreCase, full }, host) => {
    const result = await searchAgentTranscript({
      agentManager: host.agentManager,
      agentStorage: host.agentStorage,
      rootAgentId: agentId,
      pattern,
      tree,
      regex,
      caseInsensitive: ignoreCase,
      full,
    });
    return toResult(result);
  },
});

// ---------------------------------------------------------------------------------------------
// Work queue (OR-A1): owned work items with a required closure. docs/work-queue.md
// ---------------------------------------------------------------------------------------------

const CLOSURE_HELP =
  "done needs a closure: no-follow-on, handed_off_to=<owner>, blocked_on=<target>, " +
  "escalation=<target>, denied or canceled; blocked needs blocked_on=<target>.";

const ClosureInputSchema = z.object({
  reason: z.enum(WORK_ITEM_CLOSURE_REASONS),
  target: z.string().optional().describe("Required for handed_off_to, blocked_on, escalation"),
  note: z.string().optional(),
});

async function requireQueue(host: CoordinationToolHost) {
  if (!host.coordination) throw new Error("The work queue is not enabled on this daemon.");
  return (await host.coordination.require()).queue;
}

/** Who is acting: the calling agent, or `human` for a session with no agent id. */
function actorOf(host: CoordinationToolHost): string {
  return host.callerAgentId ?? HUMAN_WORK_ITEM_OWNER;
}

function formatClosure(item: WorkItem): string | null {
  if (!item.closure) return null;
  return item.closure.target
    ? `${item.closure.reason}=${item.closure.target}`
    : item.closure.reason;
}

export interface QueueItemRow {
  id: string;
  title: string | null;
  owner: string;
  state: string;
  closure: string | null;
  delivery: string | null;
  handedOffTo?: string;
  handedOffFrom?: string;
}

/** Compact by default (OR-H4): the fields a caller acts on. `full` returns the whole item. */
export function toQueueItemRow(item: WorkItem, full: boolean): QueueItemRow | WorkItem {
  if (full) return item;
  return {
    id: item.id,
    title: truncate(item.title, 80),
    owner: item.owner,
    state: item.state,
    closure: formatClosure(item),
    delivery: item.delivery?.state ?? null,
    ...(item.handedOffTo ? { handedOffTo: item.handedOffTo } : {}),
    ...(item.handedOffFrom ? { handedOffFrom: item.handedOffFrom } : {}),
  };
}

function toTransitionRow(row: WorkItemTransition): Record<string, unknown> {
  return {
    at: row.at,
    from: row.from ?? null,
    to: row.to,
    actor: row.actor ?? null,
    ...(row.closure ? { closure: row.closure } : {}),
    ...(row.note ? { note: row.note } : {}),
  };
}

/** What the caller should do next with an item in this state. */
export function nextQueueAction(item: WorkItem, actor: string): string {
  if (item.state === "pending") {
    return item.owner === actor
      ? `Claim it with queue_claim when you start.`
      : `Waiting for ${item.owner} to claim it.`;
  }
  if (item.state === "in-progress") {
    return item.owner === actor
      ? `When finished, queue_update it to done with a closure (${CLOSURE_HELP})`
      : `${item.owner} is working on it.`;
  }
  if (item.state === "blocked")
    return `Blocked on ${item.closure?.target ?? "?"}; unblock with queue_update.`;
  if (item.state === "handed-off") return `Closed; the work continues as ${item.handedOffTo}.`;
  return "Closed. Follow-on work is a new item.";
}

const queueCreateTool = defineCoordinationTool({
  name: "queue_create",
  title: "Create work item",
  description:
    'Create a work item owned by an agent id or "human". An agent owner gets it as a prompt. ' +
    "Pass your own `id` to make a retry safe. Owners close items with a closure that says where " +
    "the work went; it cannot be dropped silently.",
  inputSchema: {
    title: z.string().min(1),
    owner: z.string().min(1).describe('An agent id, or "human"'),
    body: z.string().optional(),
    tags: z.array(z.string()).optional(),
    id: z
      .string()
      .optional()
      .describe("Caller-minted id; a repeat with the same content is a no-op"),
    full: z.boolean().optional(),
  },
  handler: async (input, host) => {
    const queue = await requireQueue(host);
    const actor = actorOf(host);
    const result = await queue.create({
      ...(input.id ? { id: input.id } : {}),
      title: input.title,
      owner: input.owner,
      createdBy: actor,
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
    });
    return toResult({
      result: result.changed ? "created" : "unchanged (already exists)",
      item: toQueueItemRow(result.item, Boolean(input.full)),
      next: nextQueueAction(result.item, actor),
    });
  },
});

const queueClaimTool = defineCoordinationTool({
  name: "queue_claim",
  title: "Claim work item",
  description:
    "Claim a work item: you become its owner and it moves to in-progress. An item someone else " +
    "has in progress cannot be claimed; use queue_handoff.",
  inputSchema: {
    id: z.string().min(1),
    note: z.string().optional(),
    full: z.boolean().optional(),
  },
  handler: async (input, host) => {
    const queue = await requireQueue(host);
    const actor = actorOf(host);
    const result = await queue.claim(input.id, {
      actor,
      ...(input.note !== undefined ? { note: input.note } : {}),
    });
    return toResult({
      result: result.changed ? "claimed" : "unchanged (already yours)",
      item: toQueueItemRow(result.item, Boolean(input.full)),
      next: nextQueueAction(result.item, actor),
    });
  },
});

const queueUpdateTool = defineCoordinationTool({
  name: "queue_update",
  title: "Update work item",
  description:
    "Change a work item's state (done, blocked, failed, denied, canceled, or back to pending / " +
    `in-progress) or its title, body and tags. ${CLOSURE_HELP}`,
  inputSchema: {
    id: z.string().min(1),
    state: WorkItemStateSchema.optional(),
    closure: ClosureInputSchema.optional(),
    note: z.string().optional(),
    title: z.string().optional(),
    body: z.string().optional(),
    tags: z.array(z.string()).optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    full: z.boolean().optional(),
  },
  handler: async (input, host) => {
    const queue = await requireQueue(host);
    const actor = actorOf(host);
    const editsFields =
      input.title !== undefined || input.body !== undefined || input.tags !== undefined;
    if (input.state && editsFields) {
      throw new Error("Change the state or edit fields, not both in one call: send two calls.");
    }
    if (!input.state && !editsFields) {
      throw new Error("Nothing to update: pass `state` (with `closure`) or title, body or tags.");
    }
    const revision =
      input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {};
    const result = input.state
      ? await queue.transition(input.id, {
          to: input.state,
          ...(input.closure ? { closure: input.closure } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
          actor,
          ...revision,
        })
      : await queue.update(input.id, {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.tags ? { tags: input.tags } : {}),
          ...revision,
        });
    const changedText = input.state ? `moved to ${result.item.state}` : "updated";
    return toResult({
      result: result.changed ? changedText : "unchanged",
      item: toQueueItemRow(result.item, Boolean(input.full)),
      next: nextQueueAction(result.item, actor),
    });
  },
});

const queueHandoffTool = defineCoordinationTool({
  name: "queue_handoff",
  title: "Hand off work item",
  description:
    'Hand a work item to a new owner (agent id or "human"): closes it as handed-off and opens a ' +
    "successor for the new owner in one step, so the work cannot be lost between them.",
  inputSchema: {
    id: z.string().min(1),
    to: z.string().min(1).describe('The new owner: an agent id, or "human"'),
    note: z.string().optional(),
    title: z.string().optional(),
    body: z.string().optional(),
    full: z.boolean().optional(),
  },
  handler: async (input, host) => {
    const queue = await requireQueue(host);
    const actor = actorOf(host);
    const result = await queue.handoff(input.id, {
      to: input.to,
      actor,
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
    });
    const full = Boolean(input.full);
    return toResult({
      result: result.changed ? "handed off" : "unchanged (already handed off)",
      source: toQueueItemRow(result.source, full),
      successor: toQueueItemRow(result.successor, full),
      next: nextQueueAction(result.successor, actor),
    });
  },
});

const queueListTool = defineCoordinationTool({
  name: "queue_list",
  title: "List work items",
  description:
    'List work items, open ones by default. `owner: "me"` lists yours. Compact rows; `full: true` ' +
    "for whole items.",
  inputSchema: {
    owner: z.string().optional().describe('An agent id, "human", or "me"'),
    states: z.array(WorkItemStateSchema).optional(),
    includeClosed: z.boolean().optional(),
    limit: z.number().int().positive().max(500).optional(),
    cursor: z.string().optional(),
    full: z.boolean().optional(),
  },
  handler: async (input, host) => {
    const queue = await requireQueue(host);
    const owner = input.owner === "me" ? actorOf(host) : input.owner;
    const page = await queue.list({
      ...(owner ? { owner } : {}),
      ...(input.states ? { states: input.states } : {}),
      openOnly: !input.includeClosed && !input.states,
      limit: input.limit ?? (input.full ? FULL_ROW_LIMIT : COMPACT_ROW_LIMIT),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
    return toResult({
      count: page.items.length,
      items: page.items.map((item) => toQueueItemRow(item, Boolean(input.full))),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  },
});

const queueShowTool = defineCoordinationTool({
  name: "queue_show",
  title: "Show work item",
  description:
    "Show one work item and its last transitions. `full: true` for the whole item and every " +
    "transition.",
  inputSchema: {
    id: z.string().min(1),
    full: z.boolean().optional(),
  },
  handler: async (input, host) => {
    const queue = await requireQueue(host);
    const found = await queue.get(input.id);
    if (!found) throw new Error(`No work item with id "${input.id}". queue_list shows open items.`);
    const full = Boolean(input.full);
    const transitions = full ? found.transitions : found.transitions.slice(-5);
    return toResult({
      item: full
        ? found.item
        : { ...toQueueItemRow(found.item, false), body: truncate(found.item.body ?? null, 400) },
      transitions: transitions.map(toTransitionRow),
      next: nextQueueAction(found.item, actorOf(host)),
    });
  },
});

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

/** Append new coordination tools here. Nothing else needs to change. */
const COORDINATION_TOOLS: readonly CoordinationToolDefinition[] = [
  whoamiTool,
  listPeersTool,
  broadcastAgentPromptTool,
  searchAgentTranscriptTool,
];

/** Registered only when the host has coordination (agents.coordination.enabled). */
const QUEUE_TOOLS: readonly CoordinationToolDefinition[] = [
  queueCreateTool,
  queueClaimTool,
  queueUpdateTool,
  queueHandoffTool,
  queueListTool,
  queueShowTool,
];

export function registerCoordinationTools(options: RegisterCoordinationToolsOptions): void {
  const host: CoordinationToolHost = {
    agentManager: options.agentManager,
    agentStorage: options.agentStorage,
    ...(options.callerAgentId !== undefined ? { callerAgentId: options.callerAgentId } : {}),
    logger: options.logger,
    ...(options.coordination ? { coordination: options.coordination } : {}),
  };
  const tools = host.coordination ? [...COORDINATION_TOOLS, ...QUEUE_TOOLS] : COORDINATION_TOOLS;
  for (const tool of tools) {
    options.registerTool(tool.name, tool.config, (input, context) =>
      tool.handler(input, host, context),
    );
  }
}
