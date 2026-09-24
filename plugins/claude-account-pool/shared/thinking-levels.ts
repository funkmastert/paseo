/**
 * The known thinking-effort levels, provider-agnostic. Claude is the only
 * provider that currently reports these through `listModels`, but the ids
 * and labels live here rather than in a Claude-specific file because the
 * classifier and the settings editor both need to render and clamp a level
 * for whatever a `thinkingOptions` array actually contains — including a
 * future non-Claude provider's own ids, which `clampThinkingOption` falls
 * through to the model's own default for (see below).
 *
 * Ordered by effort, low to high: `off < minimal < low < medium < high <
 * xhigh < max`. `ultracode` (Ultra Code) is NOT a rung on that ladder: it is
 * a mode — `xhigh`'s effort plus Claude Code's multi-agent orchestration —
 * that no agent runs unless the policy or a root's request names it, and no
 * subagent ever runs (server/classifier.ts's `decideThinking`).
 * So the clamp never falls back ONTO it, and falling back FROM it lands on
 * the highest effort the model offers: a leader that can't orchestrate should
 * still think as hard as the model allows.
 */
export type ThinkingLevelId = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultracode";

/** Ultra Code's option id. */
export const ULTRACODE_OPTION_ID = "ultracode";

/**
 * The effort Ultra Code runs at (see `resolveThinkingConfig` in the daemon's
 * Claude provider). What a subagent that asked for Ultra Code gets instead:
 * the same effort, without the orchestration.
 */
export const ULTRACODE_EFFORT_OPTION_ID = "xhigh";

/** Every known id, in the order the settings editor and the manifest itself list them: the effort ladder, then Ultra Code last. */
export const THINKING_LEVEL_IDS: readonly ThinkingLevelId[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
];

/** Display label for every known id. */
export const THINKING_LEVEL_LABELS: Readonly<Record<ThinkingLevelId, string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultracode: "Ultra Code",
};

/**
 * Effort rank for the ids that are actually comparable on the ladder.
 * `ultracode` is absent on purpose — see the file header. An id absent from
 * this map (Ultra Code, an unrecognized level, or a non-Claude provider's own
 * option id) is "not on the ladder" as far as `clampThinkingOption` is
 * concerned.
 */
const THINKING_LEVEL_RANK: Readonly<Partial<Record<ThinkingLevelId, number>>> = {
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

export type ThinkingClampHow = "unclamped" | "nearest-lower" | "nearest-higher" | "highest-effort" | "model-default";

export interface ThinkingClamp {
  /** The id to actually apply — always one of `advertised`, never invented. */
  optionId: string;
  how: ThinkingClampHow;
}

/**
 * Picks the option id to apply for a wanted level against what a model
 * actually advertises. Pure: no policy, no model lookups, just the ladder
 * above and the three arguments. Never returns an id absent from `advertised`.
 *
 * - `wanted` is itself advertised: `wanted`, `unclamped`.
 * - `wanted` is Ultra Code and the model doesn't offer it: the highest
 *   advertised level on the ladder, `highest-effort`.
 * - Otherwise the nearest advertised level strictly below `wanted` on the
 *   ladder: `nearest-lower`.
 * - Otherwise (nothing lower is advertised) the nearest advertised level
 *   strictly above: `nearest-higher`.
 * - `wanted` isn't a recognized level at all, or none of `advertised` is
 *   (a non-Claude provider's own option ids): the model's own default
 *   option, else its first advertised option — `model-default` either way.
 *   This is the one path that can land on Ultra Code (a model whose default
 *   it is), which is why the classifier replaces that default with `xhigh`.
 *
 * Callers with an empty `advertised` array get `wanted` back unclamped: there
 * is nothing to clamp against, and every caller in this plugin already
 * refuses to call this before checking `advertised.length > 0` (see
 * classifier.ts's `no-thinking-options` outcome).
 */
export function clampThinkingOption(
  wanted: string,
  advertised: readonly string[],
  defaultOptionId: string | undefined,
): ThinkingClamp {
  if (advertised.length === 0 || advertised.includes(wanted)) {
    return { optionId: wanted, how: "unclamped" };
  }

  const ranked = advertised
    .map((id) => ({ id, rank: THINKING_LEVEL_RANK[id as ThinkingLevelId] }))
    .filter((entry): entry is { id: string; rank: number } => entry.rank !== undefined);
  // A default the model doesn't list is not one it offers — a provider's catalog-level default can
  // name an id this particular model lacks.
  const modelDefault = (): ThinkingClamp => ({
    optionId: defaultOptionId !== undefined && advertised.includes(defaultOptionId) ? defaultOptionId : advertised[0],
    how: "model-default",
  });

  if (wanted === ULTRACODE_OPTION_ID) {
    const highest = ranked.reduce<{ id: string; rank: number } | undefined>(
      (best, entry) => (best === undefined || entry.rank > best.rank ? entry : best),
      undefined,
    );
    return highest ? { optionId: highest.id, how: "highest-effort" } : modelDefault();
  }

  const wantedRank = THINKING_LEVEL_RANK[wanted as ThinkingLevelId];
  if (wantedRank === undefined) {
    return modelDefault();
  }

  let nearestLower: { id: string; rank: number } | undefined;
  let nearestHigher: { id: string; rank: number } | undefined;
  for (const entry of ranked) {
    if (entry.rank < wantedRank && (nearestLower === undefined || entry.rank > nearestLower.rank)) {
      nearestLower = entry;
    }
    if (entry.rank > wantedRank && (nearestHigher === undefined || entry.rank < nearestHigher.rank)) {
      nearestHigher = entry;
    }
  }

  if (nearestLower) {
    return { optionId: nearestLower.id, how: "nearest-lower" };
  }
  if (nearestHigher) {
    return { optionId: nearestHigher.id, how: "nearest-higher" };
  }
  return modelDefault();
}
