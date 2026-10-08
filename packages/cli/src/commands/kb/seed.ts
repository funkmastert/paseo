import os from "node:os";
import type { Command } from "commander";
import { SPEND_BUDGET_LABEL } from "@getpaseo/server";
import type { CommandError, CommandOptions, ListResult, OutputSchema } from "../../output/index.js";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import { buildSeedBrief } from "./seed-brief.js";

const TASK_CLASS_LABEL = "paseo.task-class";
// Generous: a seed agent reads a bounded set of sources across repos and ~/bozeo-ops and cites
// one on every entry, closer to an implementation task than a quick lookup.
const SEED_BUDGET_TOKENS = 1_500_000;

export interface KbSeedOptions extends CommandOptions {
  hint?: string;
}

export interface KbSeedAgentResult {
  name: string;
  agentId: string;
  title: string | null;
}

export const kbSeedSchema: OutputSchema<KbSeedAgentResult> = {
  idField: "agentId",
  columns: [
    { header: "PROJECT", field: "name" },
    { header: "AGENT ID", field: "agentId", width: 12 },
    { header: "TITLE", field: "title" },
  ],
};

async function connectOrThrow(hostOption: string | undefined, host: string) {
  try {
    return await connectToDaemon({ host: hostOption });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  }
}

/** `paseo kb seed <name...> [--hint]` (KTD-13): one seed agent per name, never run by the daemon. */
export async function runKbSeedCommand(
  names: string[],
  options: KbSeedOptions,
  _command: Command,
): Promise<ListResult<KbSeedAgentResult>> {
  if (names.length === 0) {
    throw {
      code: "MISSING_PROJECT_NAME",
      message: "At least one project name is required",
      details: 'Usage: paseo kb seed "<project name>" [more names...] [--hint <text>]',
    } satisfies CommandError;
  }

  const host = getDaemonHost({ host: options.host });
  const client = await connectOrThrow(options.host, host);
  try {
    const status = await client.getKnowledgeBaseStatus();
    if (!status.enabled) {
      throw {
        code: "KNOWLEDGE_BASE_DISABLED",
        message: "The knowledge base is not enabled on this daemon",
        details:
          'Set "knowledgeBase": { "enabled": true } in config.json, then `paseo daemon reload` ' +
          "(run `paseo kb setup` first if Basic Memory isn't installed yet).",
      } satisfies CommandError;
    }

    const results: KbSeedAgentResult[] = [];
    for (const name of names) {
      const agent = await client.createAgent({
        provider: "claude",
        cwd: os.homedir(),
        title: `Seed: ${name}`,
        initialPrompt: buildSeedBrief(name, options.hint),
        labels: {
          [TASK_CLASS_LABEL]: "standard",
          [SPEND_BUDGET_LABEL]: String(SEED_BUDGET_TOKENS),
        },
      });
      results.push({ name, agentId: agent.id, title: agent.title });
    }
    return { type: "list", data: results, schema: kbSeedSchema };
  } finally {
    await client.close().catch(() => {});
  }
}
