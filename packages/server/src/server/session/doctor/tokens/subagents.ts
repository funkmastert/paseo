import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DoctorContext } from "../context.js";
import { realpathOrNull } from "../helpers.js";
import { auditAccounts, auditCwds, readAgentProcesses } from "./settings.js";
import { row, type TokenAuditCheck, type TokenAuditRow } from "./types.js";

export interface AgentFile {
  file: string;
  name: string;
  /** The `model:` frontmatter value; null when the file does not set one. */
  model: string | null;
}

/** The `model:` key of a markdown file's YAML frontmatter. No YAML parser: one flat key. */
export function readAgentModel(text: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  const line = /^model:\s*(.+?)\s*$/m.exec(match[1] as string);
  return line ? (line[1] as string).replace(/^["']|["']$/g, "") : null;
}

function agentFilesIn(dir: string): AgentFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".md"))
    .flatMap((name) => {
      const file = path.join(dir, name);
      try {
        return [
          {
            file,
            name: name.replace(/\.md$/, ""),
            model: readAgentModel(readFileSync(file, "utf8")),
          },
        ];
      } catch {
        return [];
      }
    });
}

interface OverrideState {
  /** What CLAUDE_CODE_SUBAGENT_MODEL is, and where, for the evidence column. */
  text: string;
  /** True when it is set on every provider and on every running agent that was probed. */
  everywhere: boolean;
  processesProbed: boolean;
}

/** CLAUDE_CODE_SUBAGENT_MODEL overrides every agent file's model, so it decides what "inherits" costs. */
async function readOverride(
  ctx: DoctorContext,
  accounts: ReturnType<typeof auditAccounts>,
): Promise<OverrideState> {
  const overrides = new Map<string, string>();
  for (const account of accounts) {
    for (const entry of account.providerEnv) {
      if (entry.name === "CLAUDE_CODE_SUBAGENT_MODEL") {
        overrides.set(`provider ${account.providers.join("+")}`, entry.display);
      }
    }
  }
  const processes = await readAgentProcesses(ctx);
  const fromProcesses = new Map<string, number>();
  for (const proc of processes ?? []) {
    const value = proc.env.find((e) => e.name === "CLAUDE_CODE_SUBAGENT_MODEL")?.display ?? "unset";
    fromProcesses.set(value, (fromProcesses.get(value) ?? 0) + 1);
  }
  const parts = [...overrides].map(([where, value]) => `${where}: ${value}`);
  if (processes) {
    const tally = [...fromProcesses].map(([v, n]) => `${v} on ${n}`).join(", ");
    parts.push(`running agents: ${tally || "none running"}`);
  }
  return {
    text: parts.join("; "),
    everywhere: overrides.size > 0 && [...fromProcesses.keys()].every((value) => value !== "unset"),
    processesProbed: processes !== null,
  };
}

function fileRow(file: AgentFile, override: OverrideState): TokenAuditRow {
  const inherits = file.model === null;
  const flagged = inherits && !override.everywhere;
  const overrideNote = override.text
    ? `; CLAUDE_CODE_SUBAGENT_MODEL — ${override.text}`
    : "; CLAUDE_CODE_SUBAGENT_MODEL not set anywhere audited";
  return row(
    "subagents",
    `subagents:file:${realpathOrNull(file.file) ?? file.file}`,
    flagged ? "AMBER" : "GREEN",
    `Agent ${file.name}: ${inherits ? "inherits the caller's model" : `model ${file.model}`}`,
    `${file.file}: ${inherits ? "no model: key" : `model: ${file.model}`}${overrideNote}`,
    flagged
      ? "runs on the leader's (most expensive) model"
      : "runs on the model named, not the leader's",
  );
}

function summaryRow(input: {
  files: AgentFile[];
  inheriting: number;
  dirs: string[];
  override: OverrideState;
}): TokenAuditRow {
  const { files, inheriting, override } = input;
  const flagged = inheriting > 0 && !override.everywhere;
  const probeNote = override.processesProbed
    ? ""
    : "; running agent processes not probed (needs macOS ps)";
  const overrideNote = override.text ? `; CLAUDE_CODE_SUBAGENT_MODEL — ${override.text}` : "";
  return row(
    "subagents",
    "subagents:summary",
    flagged ? "AMBER" : "GREEN",
    `${files.length} agent files, ${inheriting} inherit the caller's model`,
    `looked in ${input.dirs.join(", ")}${probeNote}${overrideNote}`,
    files.length === 0
      ? "no agent files; subagents spawned by the Agent tool take the model the caller passes, else the override above"
      : `${inheriting} agents run on the leader's model unless the override applies`,
    { "subagents.inheriting": inheriting, "subagents.files": files.length },
  );
}

export const subagentsCheck: TokenAuditCheck = {
  id: "tokens.subagents",
  item: "subagents",
  timeoutMs: 30_000,
  async measure(ctx: DoctorContext) {
    const accounts = auditAccounts(ctx);
    const dirs = new Set<string>();
    for (const account of accounts) dirs.add(path.join(account.configDir, "agents"));
    for (const cwd of auditCwds(ctx)) dirs.add(path.join(cwd, ".claude", "agents"));

    const byPath = new Map<string, AgentFile>();
    for (const dir of dirs) {
      for (const file of agentFilesIn(dir))
        byPath.set(realpathOrNull(file.file) ?? file.file, file);
    }
    const files = [...byPath.values()];
    const override = await readOverride(ctx, accounts);
    return [
      ...files.map((file) => fileRow(file, override)),
      summaryRow({
        files,
        inheriting: files.filter((file) => file.model === null).length,
        dirs: [...dirs],
        override,
      }),
    ];
  },
};
