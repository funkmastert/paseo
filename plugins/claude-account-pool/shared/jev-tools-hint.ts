/**
 * Features 4-6 (docs/jev.md): seven tools exist on the daemon's agent MCP endpoint for agents
 * the D8 draw put in the "on" arm, but Claude Code defers their schemas behind `ToolSearch`,
 * bare name only, inside a deferred list that can carry 100+ other names. Nothing told an
 * eligible agent to go looking, so none ever did (docs/jev.md, Features 4-6, "Which agents get
 * them"): zero `ToolSearch` calls and zero tool calls across hundreds of eligible sessions. This
 * is the discovery half — the same "tell the agent what it has" shape `restriction-notice.ts`
 * uses for tool denials, folded into `providerOptions.appendSystemPrompt` the same way. Written
 * only for the "on" arm; the control arm gets nothing, so the D8 comparison stays clean.
 */
export const JEV_TOOLS_DISCOVERY_HINT =
  "You have seven extra tools for judging files and command output without reading them into " +
  "your context: ask_jev_file_bool, ask_jev_file_choice, ask_jev_file_score, ask_jev_files, " +
  "pick_first_file, ask_jev and ask_jev_diff_risk. They are not in your tool list yet. Before " +
  "reading a large file or running an exploratory command, search tools for `ask_jev` to load " +
  "them.";
