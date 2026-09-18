import { profileDeniedTools, type ToolProfileId } from "./tool-profiles";


/**
 * The prompt-side half of tool enforcement.
 *
 * `applyToolProfile` makes a denial real; this makes it VISIBLE. Without it a
 * restricted agent learns its limits the only other way available — by
 * reaching for `Edit`, being told no, and then trying to route around it.
 * That discovery is the single most expensive thing about this feature: the
 * production incident that motivated the whole guard-rail rework had one
 * agent burn 1.1M tokens working out it had no Edit/Write/Bash, and another
 * spend 387k spawning helpers that turned out to be just as disarmed.
 *
 * So a restricted agent is told, in its own initial prompt, three things:
 * what is gone, that it is gone for good (not a permission prompt away), and
 * what to do instead. The notice is PREPENDED, never substituted — the task
 * the caller wrote is still the task.
 *
 * Budget: this is paid on every restricted spawn, so the built-in notices are
 * hand-written to land around 80 tokens rather than generated from the deny
 * list. Enumerating `read-only`'s full list (19 tool names once the browser
 * actuators are in, most of them `mcp__paseo__`-prefixed and 6-8 tokens each)
 * costs ~150 tokens on every spawn — spending that to name tools the agent
 * would never have reached for is the same waste in a different pocket. The
 * notices therefore name the native Claude tools exactly (those are the ones
 * an agent reaches for by reflex, and the ones whose absence derails a turn)
 * and name the Paseo MCP groups by family. An agent that tries a family
 * member anyway gets one cheap tool error, not a lost turn.
 *
 * An `unrestricted` (or otherwise empty) profile produces nothing at all:
 * `restrictionNotice` returns undefined and the request passes through
 * byte-identical. The common path costs zero tokens.
 */

/** How many tool names a generated (custom-profile) notice spells out before summarizing. */
export const MAX_ENUMERATED_TOOLS = 12;

/**
 * Hand-written notices for the built-in restrictive profiles. Matched on the
 * EFFECTIVE deny list rather than on the role's configured profile kind, so a
 * worker that inherited `read-only` from the agent that spawned it gets the
 * accurate `read-only` copy. A deny list that matches no built-in — a custom
 * profile, or a built-in widened by inheritance — falls through to the
 * generated form, which describes what was actually applied.
 */
const BUILT_IN_NOTICE: Partial<Record<ToolProfileId, string>> = {
  "read-only": [
    "[tool profile: read-only]",
    "Edit, MultiEdit, Write, NotebookEdit and Bash were removed from your context at launch — not gated, not requestable. So were Paseo's terminal and workspace-script MCP tools. Report the change you'd make (exact paths, a diff) rather than making it, and don't route around this.",
  ].join("\n"),
  orchestrator: [
    "[tool profile: orchestrator]",
    "Read, Glob, Grep, Edit, MultiEdit, Write, NotebookEdit, Bash, Task and Agent were removed from your context at launch — not gated, not requestable. So were Paseo's terminal and workspace-script MCP tools. You can't do anything yourself: delegate each step with mcp__paseo__create_agent.",
  ].join("\n"),
};

function covers(subset: readonly string[], superset: readonly string[]): boolean {
  const all = new Set(superset);
  return subset.every((tool) => all.has(tool));
}

function toolList(tools: readonly string[]): string {
  const shown = tools.slice(0, MAX_ENUMERATED_TOOLS);
  const remaining = tools.length - shown.length;
  return remaining > 0 ? `${shown.join(", ")} and ${remaining} more` : shown.join(", ");
}

function generatedNotice(denied: readonly string[]): string {
  const list = toolList(denied);
  return [
    "[tool profile: custom]",
    `Removed from your context at launch — not gated, not requestable: ${list}. If the task genuinely needs one, say so and stop rather than routing around it.`,
  ].join("\n");
}

export interface RestrictionNoticeOptions {
  /**
   * True when some of `denied` came from the agent that spawned this one
   * rather than from its own role. Worth one extra sentence: an agent whose
   * role is nominally unrestricted, told only that `Edit` is gone, will
   * reasonably suspect a misconfiguration and go looking.
   */
  inherited?: boolean;
}

/**
 * The block to prepend for an effective deny list, or undefined when nothing
 * was denied and the prompt must stay byte-identical.
 */
export function restrictionNotice(
  denied: readonly string[],
  options: RestrictionNoticeOptions = {},
): string | undefined {
  if (denied.length === 0) {
    return undefined;
  }
  const inheritedSuffix = options.inherited
    ? "\nThis came from the agent that spawned you, which is restricted too; report back to it."
    : "";
  // Widest first: `orchestrator` denies everything `read-only` does and more.
  // A built-in whose denials are a SUBSET of what was applied still gets its
  // hand-written copy, with the extras appended — cheaper and clearer than
  // regenerating a bare list of nineteen names because one tool was added.
  for (const kind of ["orchestrator", "read-only"] as const) {
    const base = profileDeniedTools({ kind });
    if (!covers(base, denied)) {
      continue;
    }
    const extras = denied.filter((tool) => !base.includes(tool));
    const also = extras.length > 0 ? `\nAlso removed: ${toolList(extras)}.` : "";
    return `${BUILT_IN_NOTICE[kind] as string}${also}${inheritedSuffix}`;
  }
  return `${generatedNotice(denied)}${inheritedSuffix}`;
}

/**
 * The `initialPrompt` a restricted request should carry, or undefined when it
 * must not be touched.
 *
 * Undefined is returned both when there is nothing to say and when there is
 * no prompt to say it in. The second case is deliberate: setting
 * `initialPrompt` on a create that had none would hand the daemon a first
 * turn to run, turning an interactive agent a human is about to type into
 * one that starts talking to itself. A restricted interactive agent learns
 * its limits from its operator instead, who is by definition present.
 */
export function initialPromptWithNotice(
  initialPrompt: string | undefined,
  denied: readonly string[],
  options: RestrictionNoticeOptions = {},
): string | undefined {
  if (typeof initialPrompt !== "string" || initialPrompt.trim().length === 0) {
    return undefined;
  }
  const notice = restrictionNotice(denied, options);
  if (notice === undefined) {
    return undefined;
  }
  return `${notice}\n\n${initialPrompt}`;
}
