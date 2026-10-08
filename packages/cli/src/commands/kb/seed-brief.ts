/**
 * The fixed seed brief `paseo kb seed` sends a seed agent (docs/knowledge-base.md, KTD-13). One
 * per invocation, parameterized by the project name the caller typed — never a project name
 * baked into this file, so no Wonderly initiative name lands in the repo.
 */
export function buildSeedBrief(name: string, hint?: string): string {
  const hintLine = hint ? `\nHint from Tyler, on where to look: ${hint}\n` : "";
  return `You are seeding Bozeo's project knowledge base for one project: "${name}".
${hintLine}
Read a bounded set of sources for this project and nothing else:
- Any repo whose work matches this project: its docs/plans/ directory, and any auto-memory files written for it.
- ~/bozeo-ops: its briefs and recorded state.
- Bozeo's own agent history: use the paseo MCP tools (list_agents, get_agent_activity) to find agents and sessions that worked on this project.

First call kb_search("${name}"). If it returns a strong match, open it with kb_open and file into that project. Otherwise create it with kb_create("${name}", <a one- or two-sentence summary of the goal, drawn only from what you read>).

For every fact you find — a Figma file, a ticket, a PR, a dashboard link, a decision and why it was made, a rule, or where work stands — file it with kb_record (kind "link", "decision", "rule" or "status"), and name the source you found it in (a file path, a URL, or an agent id) in the text. Write only what these sources actually say; do not infer or invent a fact to fill a gap.

When you run out of sources, end with a recall self-check: call kb_search("${name}") again, as a fresh agent would with only that name to go on, and confirm it returns this project. Report the project's slug, a one-line summary of what you filed, and the self-check result.`;
}
