/**
 * Features 4-6 (docs/jev.md): seven tools, eager-loaded on their own small MCP server
 * (`runtime-mcp-config.ts`'s `withRuntimeJevToolsMcpServer`) for agents the D8 draw put in the
 * "on" arm, so Claude Code never defers their schemas behind `ToolSearch`. The eager load alone
 * didn't fix usage: a tool present in the list but never named in the standing instructions is
 * easy to never reach for. This is the usage half — the same "tell the agent what it has" shape
 * `restriction-notice.ts` uses for tool denials, folded into `providerOptions.appendSystemPrompt`
 * the same way. One concrete rule, not a sentence that only says the tools exist. Written only
 * for the "on" arm; the control arm gets nothing, so the D8 comparison stays clean.
 */
export const JEV_TOOLS_USAGE_HINT =
  "You have seven extra tools for judging files and command output without reading them into " +
  "your context: ask_jev_file_bool, ask_jev_file_choice, ask_jev_file_score, ask_jev_files, " +
  "pick_first_file, ask_jev and ask_jev_diff_risk. Before reading a file over about 8,000 " +
  "tokens, or before scanning a directory to find something, ask one of these first. Open the " +
  "file (or run the scan) only if the answer tells you to.";
