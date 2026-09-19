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
 * them is what their tasks were worth, which only the caller knows — hence a declared budget.
 *
 * One budget covers one agent, not a task tree. Labels are not inherited, and every agent's spend is
 * its own, so a leader that delegates its work is governed on its coordination rather than on the
 * job. Budget the agents that spend.
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
  /**
   * Whether the agent was mid-turn at the end of the last sweep, which is how `pause` re-arms.
   *
   * A sweep that plans a pause records this as false even though the agent is running as it
   * plans: the pause is about to stop it. Recording the truth of the instant would hide the
   * restart that follows — a parent that re-prompts its paused child inside the 60s before the
   * next sweep would look like an agent that never stopped, and `pause` would stay fired.
   */
  wasRunning: boolean;
  /**
   * Stages that fired while the agent was idle, so the message never reached it. Steering an
   * idle agent starts a fresh turn (agent-prompt.ts's fallback), which would spend tokens to
   * say an agent is out of tokens — so the message waits here until the agent is mid-turn.
   *
   * Firing and telling are separate for exactly one stage that matters: `notify` is the only
   * stage on by default, its whole value is the chance to wrap up early, and an agent that
   * crossed 0.75x between turns used to be marked told and never hear a word.
   */
  undeliveredStages: readonly SpendGovernorStage[];
  /**
   * The model the agent was on before `downgrade` moved it. Kept so account failover can put a
   * successor back on it: a migrated agent starts with its spend at zero but inherits the
   * model, and the fresh episode then marks `downgrade` done because the agent is already on
   * the target. Without this an agent that was downgraded once stays cheap forever, on a
   * budget it is no longer anywhere near.
   *
   * Deliberately outlives an episode. It is not a fact about this budget, it is a fact about
   * what the governor changed.
   */
  modelBeforeDowngrade?: string;
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
  /**
   * This stage already fired and was already pushed; all that is left is the message that
   * could not be delivered at the time. Perform nothing, push nothing, just tell the agent.
   */
  redelivery?: boolean;
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

/**
 * Whether `pause` gets another turn. Somebody started this agent after the governor stopped it
 * and it is still over the threshold, so the turn it has just begun is exactly the turn the
 * stage exists to end. Without this a stage that fires once reads as protection while the agent
 * it stopped runs on unbounded — measured at eight times its budget, with the governor watching
 * and planning nothing.
 *
 * Re-arming is not a release. Raising the budget label is, and that starts a fresh episode.
 */
/** Switched on, not already fired this episode, and the spend is past its line. */
function stageIsReady(
  settings: SpendGovernorStageConfig,
  stage: SpendGovernorStage,
  fired: ReadonlySet<SpendGovernorStage>,
  fraction: number,
): boolean {
  return settings.enabled && !fired.has(stage) && fraction >= settings.atFraction;
}

/**
 * A downgrade with nowhere to go, or one to the model the agent is already on. Marked fired
 * without acting: re-deciding it every sweep for the rest of the agent's life is pure noise.
 */
function downgradeIsMoot(agent: SpendGovernorAgentInput, config: SpendGovernorConfig): boolean {
  return !config.downgradeToModel || agent.model === config.downgradeToModel;
}

/** Whether this sweep is about to stop the agent, which is what `wasRunning` has to record. */
function isStoppingTheAgent(
  actions: readonly SpendGovernorAction[],
  config: SpendGovernorConfig,
): boolean {
  return !config.dryRun && actions.some((action) => action.stage === "pause");
}

/**
 * The messages owed to an agent that has just come back mid-turn. A stage that fired while it
 * was idle went out as a push and a state change but was never said to the agent itself; this
 * is where it finally gets said. Ladder order, and only what is genuinely outstanding.
 */
/** Where a downgrade is headed. Empty for every other stage, and for a downgrade with nowhere to go. */
/**
 * The model to remember as this agent's own, the first time the governor moves it off one. A
 * dry run moves nothing, so it has nothing to remember.
 */
/** What the next sweep is handed: this sweep's bookkeeping, plus what outlives the episode. */
function buildNextState(input: {
  previousState: SpendGovernorState | undefined;
  agent: SpendGovernorAgentInput;
  config: SpendGovernorConfig;
  actions: readonly SpendGovernorAction[];
  budgetTokens: number;
  fired: ReadonlySet<SpendGovernorStage>;
  undelivered: ReadonlySet<SpendGovernorStage>;
}): SpendGovernorState {
  const { agent, config, actions, fired } = input;
  // Read from `previousState`, not the episode-matched `carried`: what the governor moved this
  // agent off is not a fact about the budget it was over at the time, so a raised label must
  // not forget it.
  const modelBeforeDowngrade =
    input.previousState?.modelBeforeDowngrade ?? modelDepartedThisSweep(actions, agent, config);
  return {
    budgetTokens: input.budgetTokens,
    firedStages: [...fired],
    fanOutBlocked: fired.has("stopFanOut") && !config.dryRun,
    wasRunning: agent.isRunning && !isStoppingTheAgent(actions, config),
    undeliveredStages: [...input.undelivered],
    ...(modelBeforeDowngrade ? { modelBeforeDowngrade } : {}),
  };
}

function modelDepartedThisSweep(
  actions: readonly SpendGovernorAction[],
  agent: SpendGovernorAgentInput,
  config: SpendGovernorConfig,
): string | undefined {
  if (config.dryRun || !agent.model) return undefined;
  return actions.some((action) => action.stage === "downgrade") ? agent.model : undefined;
}

function targetModelFor(
  stage: SpendGovernorStage,
  config: SpendGovernorConfig,
): { targetModel?: string } {
  if (stage !== "downgrade" || !config.downgradeToModel) return {};
  return { targetModel: config.downgradeToModel };
}

/**
 * Whether this stage's message has to wait. An idle agent cannot be steered without starting a
 * turn, and a dry run says nothing to anybody.
 */
function messageWaits(agent: SpendGovernorAgentInput, config: SpendGovernorConfig): boolean {
  if (config.dryRun) return false;
  return !agent.isRunning;
}

function planRedeliveries(input: {
  agent: SpendGovernorAgentInput;
  undelivered: Set<SpendGovernorStage>;
  budgetTokens: number;
  spentTokens: number;
  config: SpendGovernorConfig;
}): SpendGovernorAction[] {
  if (!input.agent.isRunning || input.config.dryRun) return [];
  const actions: SpendGovernorAction[] = [];
  for (const stage of SPEND_GOVERNOR_STAGES) {
    if (!input.undelivered.delete(stage)) continue;
    actions.push({
      agentId: input.agent.id,
      stage,
      budgetTokens: input.budgetTokens,
      // The spend as it reads now, not as it read when the stage fired: the agent is about to
      // read this sentence, and the number in it should be the one it can still act on.
      spentTokens: input.spentTokens,
      redelivery: true,
    });
  }
  return actions;
}

function shouldReArmPause(
  carried: SpendGovernorState | undefined,
  agent: SpendGovernorAgentInput,
  fraction: number,
  config: SpendGovernorConfig,
): boolean {
  if (carried === undefined || carried.wasRunning || !agent.isRunning) return false;
  return fraction >= config.pause.atFraction;
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
  const undelivered = new Set<SpendGovernorStage>(carried?.undeliveredStages ?? []);
  const fraction = spentTokens / budgetTokens;

  if (shouldReArmPause(carried, agent, fraction, config)) {
    fired.delete("pause");
  }

  const actions: SpendGovernorAction[] = planRedeliveries({
    agent,
    undelivered,
    budgetTokens,
    spentTokens,
    config,
  });

  for (const stage of SPEND_GOVERNOR_STAGES) {
    if (!stageIsReady(stageConfig(config, stage), stage, fired, fraction)) {
      continue;
    }
    if (stage === "downgrade" && downgradeIsMoot(agent, config)) {
      fired.add(stage);
      continue;
    }
    if (!canPerform(stage, agent)) {
      continue;
    }
    fired.add(stage);
    // `notify` and `stopFanOut` can fire on an idle agent, and an idle agent cannot be steered
    // without starting a turn. Remember the message rather than counting it as said.
    if (messageWaits(agent, config)) {
      undelivered.add(stage);
    }
    actions.push({
      agentId: agent.id,
      stage,
      budgetTokens,
      spentTokens,
      ...targetModelFor(stage, config),
    });
  }

  return {
    actions,
    nextState: buildNextState({
      previousState: input.previousState,
      agent,
      config,
      actions,
      budgetTokens,
      fired,
      undelivered,
    }),
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
