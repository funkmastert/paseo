/**
 * Pure decision logic for the spend governor — which graduated action an agent has earned by
 * spending past the budget its caller declared for the task. No I/O, no clock reads: the
 * monitor calls this once per agent per sweep and carries the returned state to the next one,
 * the same contract token-burn-detector.ts and build-daemon-reaper.ts keep.
 *
 * The governed quantity is cumulative cost-weighted spend against a declared budget, not the
 * trailing rate. Measured on one machine, a healthy Opus agent doing ordinary work sustains
 * 100–200K weighted tokens/min, because the weighted rate is mostly a readout of how large a
 * context is being re-read per request — it grows as a task progresses and says nothing about
 * whether the work is worth doing. Two finished, entirely healthy implementation agents spent
 * 1.08M and 1.48M; the flailing agent this feature exists to catch spent 1.1M discovering it
 * had no Edit tool. No rate and no single global total separates those three. What separates
 * them is what their tasks were worth, which only the caller knows — hence a per-task budget.
 *
 * See docs/token-burn.md.
 */
import type { SpendGovernorStage } from "@getpaseo/protocol/token-burn-notification";

export type { SpendGovernorStage };

/**
 * Where a caller declares what a task ought to cost, in cost-weighted tokens. A label rather
 * than a new create field: labels are already on `create_agent`'s input schema, an
 * `agent.create` plugin hook can impose or override one, `update_agent` can raise one on a
 * live agent, and none of it costs a protocol change.
 */
export const SPEND_BUDGET_LABEL = "paseo.budget";

/** Ladder order. A sweep that crosses several at once performs them in this order. */
export const SPEND_GOVERNOR_STAGES: readonly SpendGovernorStage[] = [
  "notify",
  "downgrade",
  "stopFanOut",
  "pause",
];

export interface SpendGovernorStageConfig {
  enabled: boolean;
  /** Multiple of the budget at which this stage fires. */
  atFraction: number;
}

export interface SpendGovernorConfig {
  enabled: boolean;
  dryRun: boolean;
  /**
   * Budget for an agent whose task declared none. Null means an undeclared task is not
   * governed at all — the shipped default, so turning the governor on cannot act on agents
   * nobody has sized. Set it once dry-run has shown what your agents actually cost.
   */
  defaultBudgetTokens: number | null;
  /** Model the downgrade stage moves an agent to. Null leaves that stage inert. */
  downgradeToModel: string | null;
  notify: SpendGovernorStageConfig;
  downgrade: SpendGovernorStageConfig;
  stopFanOut: SpendGovernorStageConfig;
  pause: SpendGovernorStageConfig;
}

export interface SpendGovernorState {
  /**
   * The budget these stages were fired against. A budget that changes — a human raising the
   * label on a paused agent — starts a fresh episode rather than leaving it stuck at a
   * threshold it is no longer over.
   */
  budgetTokens: number;
  firedStages: readonly SpendGovernorStage[];
  /**
   * Separate from `firedStages` containing `stopFanOut` so a dry run cannot quietly enforce.
   * Dry run still records the stage as fired — it is reported once, not once a minute — but
   * only a real run flips this, and only this is what `create_agent` refuses on.
   */
  fanOutBlocked: boolean;
}

/** Per-agent facts the planner needs. A lean view, like the monitor summaries it is built from. */
export interface SpendGovernorAgentInput {
  id: string;
  labels: Record<string, string>;
  /** Cumulative cost-weighted spend. Undefined for a provider that reports nothing. */
  totalTokens: number | undefined;
  /** Mid-turn right now. Only a running agent can be downgraded or paused. */
  isRunning: boolean;
  /** Current model id, so a downgrade to the model it is already on is not performed twice. */
  model: string | undefined;
}

export interface SpendGovernorAction {
  agentId: string;
  stage: SpendGovernorStage;
  budgetTokens: number;
  spentTokens: number;
  /** Set on `downgrade`: the model to move to. */
  targetModel?: string;
}

export interface PlanSpendGovernorInput {
  agent: SpendGovernorAgentInput;
  config: SpendGovernorConfig;
  previousState: SpendGovernorState | undefined;
}

export interface PlanSpendGovernorResult {
  actions: SpendGovernorAction[];
  /** Undefined when the agent has no budget to govern; the monitor clears any stale state. */
  nextState: SpendGovernorState | undefined;
}

const BUDGET_SUFFIXES: Record<string, number> = { k: 1_000, m: 1_000_000 };

/**
 * Accepts `300000`, `300k`, `1.5M`, and `2_000_000`. Agents write this label by hand from a
 * prompt, so the forgiving forms are the ones that actually turn up; anything else is ignored
 * rather than guessed at, because guessing a budget wrong either throttles healthy work or
 * governs nothing.
 */
export function parseBudgetLabel(value: string | undefined): number | null {
  if (typeof value !== "string") return null;
  const match = /^\s*([0-9][0-9_]*(?:\.[0-9]+)?)\s*([km])?\s*$/i.exec(value);
  if (!match) return null;
  const magnitude = Number.parseFloat(match[1]!.replace(/_/g, ""));
  if (!Number.isFinite(magnitude) || magnitude <= 0) return null;
  const suffix = match[2]?.toLowerCase();
  const scaled = suffix ? magnitude * BUDGET_SUFFIXES[suffix]! : magnitude;
  return scaled > 0 ? scaled : null;
}

export function resolveAgentBudget(
  agent: Pick<SpendGovernorAgentInput, "labels">,
  config: Pick<SpendGovernorConfig, "defaultBudgetTokens">,
): number | null {
  return parseBudgetLabel(agent.labels[SPEND_BUDGET_LABEL]) ?? config.defaultBudgetTokens;
}

function stageConfig(
  config: SpendGovernorConfig,
  stage: SpendGovernorStage,
): SpendGovernorStageConfig {
  return config[stage];
}

/**
 * A stage the agent has crossed but cannot be acted on yet is deliberately NOT marked fired, so
 * the next sweep retries it. That covers the case worth catching: an agent that blew its budget
 * and then went idle gets paused when it starts spending again, rather than being written off
 * as handled while it was briefly between turns.
 */
function canPerform(stage: SpendGovernorStage, agent: SpendGovernorAgentInput): boolean {
  if (stage === "downgrade" || stage === "pause") return agent.isRunning;
  return true;
}

export function planSpendGovernorActions(input: PlanSpendGovernorInput): PlanSpendGovernorResult {
  const { agent, config } = input;
  if (!config.enabled) {
    return { actions: [], nextState: undefined };
  }

  const budgetTokens = resolveAgentBudget(agent, config);
  const spentTokens = agent.totalTokens;
  if (budgetTokens === null || spentTokens === undefined) {
    return { actions: [], nextState: undefined };
  }

  // A changed budget is a new episode. Cumulative spend only grows, so without this a paused
  // agent could never be released: raising its label would leave `pause` already fired.
  const carried =
    input.previousState && input.previousState.budgetTokens === budgetTokens
      ? input.previousState
      : undefined;
  const fired = new Set<SpendGovernorStage>(carried?.firedStages ?? []);
  const fraction = spentTokens / budgetTokens;
  const actions: SpendGovernorAction[] = [];

  for (const stage of SPEND_GOVERNOR_STAGES) {
    const settings = stageConfig(config, stage);
    if (!settings.enabled || fired.has(stage) || fraction < settings.atFraction) {
      continue;
    }
    if (stage === "downgrade") {
      // Nothing to move to, or already there. Marked fired either way: re-deciding it every
      // sweep for the rest of the agent's life would be pure noise.
      if (!config.downgradeToModel || agent.model === config.downgradeToModel) {
        fired.add(stage);
        continue;
      }
    }
    if (!canPerform(stage, agent)) {
      continue;
    }
    fired.add(stage);
    actions.push({
      agentId: agent.id,
      stage,
      budgetTokens,
      spentTokens,
      ...(stage === "downgrade" && config.downgradeToModel
        ? { targetModel: config.downgradeToModel }
        : {}),
    });
  }

  return {
    actions,
    nextState: {
      budgetTokens,
      firedStages: [...fired],
      fanOutBlocked: fired.has("stopFanOut") && !config.dryRun,
    },
  };
}

/**
 * True once the governor has cut an agent off from `create_agent`. Read by the tool itself
 * (paseo-tools.ts) rather than pushed anywhere: the gate has to hold between sweeps, and the
 * agent asking is the only moment it matters.
 */
export function isFanOutBlocked(state: SpendGovernorState | undefined): boolean {
  return state?.fanOutBlocked ?? false;
}
