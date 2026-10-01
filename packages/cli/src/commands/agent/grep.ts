import type { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandOptions, ListResult, OutputSchema, CommandError } from "../../output/index.js";
import type { AgentTranscriptSearchAgentResult } from "@getpaseo/protocol/transcript-search/rpc-schemas";

export function addGrepOptions(cmd: Command): Command {
  return cmd
    .description("Search an agent's transcript (or its descendant tree) for a pattern")
    .argument("<id>", "Agent ID (or prefix)")
    .argument("<pattern>", "Literal text to search for (or a regex with --regex)")
    .option("--tree", "Also search every descendant of the agent")
    .option("--regex", "Treat pattern as a regular expression")
    .option("-i, --ignore-case", "Case-insensitive search")
    .option("--full", "More matches per agent, longer excerpts, a larger total output cap");
}

export interface AgentGrepOptions extends CommandOptions {
  tree?: boolean;
  regex?: boolean;
  ignoreCase?: boolean;
  full?: boolean;
}

export interface GrepRow {
  agentId: string;
  title: string | null;
  coverage: string;
  line: number | null;
  role: string | null;
  text: string;
}

export interface GrepResultData {
  backend: string | null;
  targetSetTruncated: boolean;
  agents: AgentTranscriptSearchAgentResult[];
}

function toRows(agents: AgentTranscriptSearchAgentResult[]): GrepRow[] {
  const rows: GrepRow[] = [];
  for (const agent of agents) {
    if (agent.excerpts.length === 0) {
      rows.push({
        agentId: agent.agentId,
        title: agent.title,
        coverage: agent.coverage,
        line: null,
        role: null,
        text: `(no excerpts — coverage: ${agent.coverage})`,
      });
      continue;
    }
    for (const excerpt of agent.excerpts) {
      rows.push({
        agentId: agent.agentId,
        title: agent.title,
        coverage: agent.coverage,
        line: excerpt.lineNumber,
        role: excerpt.role,
        text: excerpt.text,
      });
    }
  }
  return rows;
}

function createGrepSchema(result: GrepResultData): OutputSchema<GrepRow> {
  return {
    idField: "agentId",
    columns: [
      { header: "AGENT", field: "agentId" },
      { header: "COVERAGE", field: "coverage" },
      { header: "LINE", field: "line" },
      { header: "ROLE", field: "role" },
      { header: "TEXT", field: "text" },
    ],
    // Every row serializes to the same full result (backend, per-agent coverage, excerpts), so
    // --json/--yaml return the one structured object instead of a flattened row list.
    serialize: () => result,
  };
}

export type AgentGrepResult = ListResult<GrepRow>;

export async function runGrepCommand(
  id: string,
  pattern: string,
  options: AgentGrepOptions,
  _command: Command,
): Promise<AgentGrepResult> {
  const host = getDaemonHost({ host: options.host });

  if (!id || !pattern) {
    const error: CommandError = {
      code: "MISSING_ARGUMENT",
      message: "Agent ID and pattern are required",
      details: "Usage: paseo agent grep <id> <pattern>",
    };
    throw error;
  }

  let client;
  try {
    client = await connectToDaemon({ host: options.host });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    };
    throw error;
  }

  try {
    if (client.getLastServerInfoMessage()?.features?.agentTranscriptSearch !== true) {
      const error: CommandError = {
        code: "UNSUPPORTED_DAEMON",
        message: "This daemon does not support transcript search yet",
        details: "Update the Paseo daemon, then retry.",
      };
      throw error;
    }

    const fetchResult = await client.fetchAgent({ agentId: id });
    if (!fetchResult) {
      const error: CommandError = {
        code: "AGENT_NOT_FOUND",
        message: `Agent not found: ${id}`,
        details: 'Use "paseo ls" to list available agents',
      };
      throw error;
    }
    const resolvedId = fetchResult.agent.id;

    const response = await client.searchAgentTranscript(resolvedId, pattern, {
      tree: options.tree,
      regex: options.regex,
      caseInsensitive: options.ignoreCase,
      full: options.full,
    });
    await client.close();

    if (response.error) {
      const error: CommandError = {
        code: "GREP_FAILED",
        message: `Transcript search failed: ${response.error}`,
      };
      throw error;
    }

    const result: GrepResultData = {
      backend: response.backend,
      targetSetTruncated: response.targetSetTruncated,
      agents: response.agents,
    };

    return {
      type: "list",
      data: toRows(result.agents),
      schema: createGrepSchema(result),
    };
  } catch (err) {
    await client.close().catch(() => {});

    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "GREP_FAILED",
      message: `Failed to search agent transcript: ${message}`,
    };
    throw error;
  }
}
