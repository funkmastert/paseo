import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DoctorProbes } from "../context.js";
import {
  fakeProbes,
  makeAccountDir,
  makeContext,
  makeFixture,
  poolConfig,
  writeConfig,
  type Fixture,
} from "../test-support.js";
import { formatTokenCount, parseContextReport, parseTokenCount } from "./context-report.js";
import { hooksCheck } from "./hooks.js";
import { gradeAgainst, memoryCheck } from "./memory.js";
import { modelCheck } from "./model.js";
import { parseAgentProcess, displayEnvValue } from "./settings.js";
import { subagentsCheck, readAgentModel } from "./subagents.js";
import { scanTranscriptTools, toolsCheck } from "./tools.js";
import {
  renderTokenAuditTable,
  row,
  rowToFinding,
  runTokenAudit,
  runTokenAuditCheck,
  TOKEN_AUDIT_CHECKS,
} from "./index.js";

function contextMarkdown(input: {
  memory: Array<[string, string, string]>;
  memoryTotal: string;
  system?: string;
  deferred?: boolean;
}): string {
  return [
    "## Context Usage",
    "",
    "**Model:** claude-opus-5-5[1m]  ",
    "**Tokens:** 26.1k / 1m (3%)",
    "",
    "### Estimated usage by category",
    "",
    "| Category | Tokens | Percentage |",
    "|----------|--------|------------|",
    `| System prompt | ${input.system ?? "2.2k"} | 0.2% |`,
    "| MCP tools | 668 | 0.1% |",
    ...(input.deferred === false
      ? []
      : ["| MCP tools (deferred) | 1.4k | 0.1% |", "| System tools (deferred) | 13.7k | 1.4% |"]),
    `| Memory files | ${input.memoryTotal} | 1.3% |`,
    "| Free space | 940.9k | 94.1% |",
    "",
    "### MCP Tools",
    "",
    "| Tool | Server | Tokens |",
    "|------|--------|--------|",
    "| mcp__docs__batch | docs | 165 |",
    "",
    "### Memory Files",
    "",
    "| Type | Path | Tokens |",
    "|------|------|--------|",
    ...input.memory.map(([type, file, tokens]) => `| ${type} | ${file} | ${tokens} |`),
    "",
    "### Skills",
    "",
    "| Skill | Source | Tokens |",
    "|-------|--------|--------|",
    "| a | User | ~290 |",
  ].join("\n");
}

function contextJson(markdown: string): string {
  return JSON.stringify({ result: markdown, total_cost_usd: 0, duration_api_ms: 0, num_turns: 0 });
}

/** A `claude` that prints the given markdown; the append run adds 1.5k to the System prompt line. */
function claudeExec(
  markdown: string,
  seen: Array<{ args: readonly string[]; cwd?: string; configDir?: string }> = [],
): DoctorProbes["exec"] {
  return async (file, args, options) => {
    if (!file.endsWith("claude")) return null;
    seen.push({ args, cwd: options.cwd, configDir: options.env?.["CLAUDE_CONFIG_DIR"] });
    const appended = args.includes("--append-system-prompt");
    return {
      stdout: contextJson(
        appended ? markdown.replace("| System prompt | 2.2k", "| System prompt | 3.7k") : markdown,
      ),
      stderr: "",
      code: 0,
    };
  };
}

function writeTranscript(fx: Fixture, slug: string, session: string, lines: unknown[]): string {
  const dir = path.join(fx.home, ".claude", "projects", slug);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${session}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

function assistantLine(
  model: string,
  id: string,
  cwd: string,
  extra: Record<string, unknown> = {},
) {
  return {
    type: "assistant",
    timestamp: "2026-09-24T19:00:00.000Z",
    cwd,
    isSidechain: false,
    message: { id, model, usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
    ...extra,
  };
}

function projectDir(fx: Fixture, name = "proj"): string {
  const dir = path.join(fx.home, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function withPool(fx: Fixture) {
  writeConfig(fx, poolConfig(fx));
  for (const name of [".claude-leader", ".claude-personal"]) {
    const dir = path.join(fx.home, name);
    makeAccountDir(dir);
    symlinkSync(path.join(fx.home, ".claude", "CLAUDE.md"), path.join(dir, "CLAUDE.md"));
  }
}

describe("token counts as /context prints them", () => {
  it("keeps the rounding step each value carried", () => {
    expect(parseTokenCount("4k")).toEqual({ value: 4000, halfStep: 500 });
    expect(parseTokenCount("8.6k")).toEqual({ value: 8600, halfStep: 50 });
    expect(parseTokenCount("740")).toEqual({ value: 740, halfStep: 0.5 });
    expect(parseTokenCount("1m")).toEqual({ value: 1_000_000, halfStep: 500_000 });
    expect(parseTokenCount("~290")).toBeNull();
    expect(parseTokenCount("< 20")).toBeNull();
    expect(formatTokenCount({ value: 8600, halfStep: 50 })).toBe("8.6k");
  });

  it("is RED only when over the limit even at the low end of its rounding", () => {
    expect(gradeAgainst({ value: 8600, halfStep: 50 }, 5000)).toBe("RED");
    expect(gradeAgainst({ value: 5000, halfStep: 500 }, 5000)).toBe("AMBER");
    expect(gradeAgainst({ value: 4000, halfStep: 500 }, 5000)).toBe("GREEN");
    expect(gradeAgainst({ value: 5100, halfStep: 50 }, 5000)).toBe("RED");
  });

  it("parses memory files, categories and MCP tools from a /context report", () => {
    const parsed = parseContextReport(
      contextMarkdown({
        memory: [
          ["User", "/h/.claude/CLAUDE.md", "4k"],
          ["Project", "/h/proj/CLAUDE.md", "8.6k"],
          ["AutoMem", "/h/proj/MEMORY.md", "740"],
        ],
        memoryTotal: "13.3k",
      }),
    );
    expect(parsed.model).toBe("claude-opus-5-5[1m]");
    expect(parsed.categories["Memory files"]).toEqual({ value: 13300, halfStep: 50 });
    expect(parsed.memoryFiles.map((f) => [f.type, f.tokens?.value])).toEqual([
      ["User", 4000],
      ["Project", 8600],
      ["AutoMem", 740],
    ]);
    expect(parsed.mcpTools).toEqual([
      { tool: "mcp__docs__batch", server: "docs", tokens: { value: 165, halfStep: 0.5 } },
    ]);
  });
});

describe("MEMORY", () => {
  function setup() {
    const fx = makeFixture();
    withPool(fx);
    const project = projectDir(fx);
    writeTranscript(fx, "-proj", "s1", [assistantLine("claude-opus-5-5", "m1", project)]);
    return { fx, project };
  }

  it("reports each file's tokens and flags a file over 5k and a total over 10k", async () => {
    const { fx, project } = setup();
    const seen: Array<{ args: readonly string[]; cwd?: string; configDir?: string }> = [];
    const markdown = contextMarkdown({
      memory: [
        ["User", path.join(fx.home, ".claude", "CLAUDE.md"), "4k"],
        ["Project", path.join(project, "CLAUDE.md"), "8.6k"],
      ],
      memoryTotal: "12.6k",
    });
    const ctx = makeContext(fx, {}, { probes: fakeProbes({ exec: claudeExec(markdown, seen) }) });
    const rows = await memoryCheck.measure(ctx, Date.now() + 60_000);
    const byKey = (needle: string) => rows.find((r) => r.key.includes(needle));
    expect(byKey("CLAUDE.md")?.severity).toBe("GREEN");
    expect(rows.find((r) => r.finding.includes(path.join(project, "CLAUDE.md")))?.severity).toBe(
      "RED",
    );
    const total = rows.find((r) => r.key === `memory:total:${project}`);
    expect(total?.severity).toBe("RED");
    expect(total?.evidence).toContain("limit 10000");
    // /context must never write a session: the audit reads transcripts back as spend.
    expect(seen.every((call) => call.args.includes("--no-session-persistence"))).toBe(true);
    expect(seen.map((call) => call.configDir)).toContain(path.join(fx.home, ".claude-leader"));
  });

  it("measures the daemon appendSystemPrompt as the difference in the System prompt line", async () => {
    const { fx, project } = setup();
    writeConfig(fx, { ...poolConfig(fx), daemon: { appendSystemPrompt: "x".repeat(4000) } });
    const markdown = contextMarkdown({
      memory: [["User", path.join(fx.home, ".claude", "CLAUDE.md"), "4k"]],
      memoryTotal: "4k",
    });
    const ctx = makeContext(fx, {}, { probes: fakeProbes({ exec: claudeExec(markdown) }) });
    const rows = await memoryCheck.measure(ctx, Date.now() + 60_000);
    const append = rows.find((r) => r.key === "memory:append-system-prompt");
    expect(append?.evidence).toContain("1500 tokens");
    expect(append?.evidence).toContain("4000 bytes");
    // 4000 bytes / 4 would have said 1000: the audit never guesses from bytes.
    expect(append?.evidence).not.toContain("1000 tokens");
    const total = rows.find((r) => r.key === `memory:total:${project}`);
    expect(total?.evidence).toContain("5500 tokens");
  });

  it("reports bytes and UNKNOWN tokens when claude cannot run, never bytes divided by four", async () => {
    const { fx, project } = setup();
    writeFileSync(path.join(project, "CLAUDE.md"), "y".repeat(2000));
    const ctx = makeContext(fx, {}, { probes: fakeProbes({ exec: async () => null }) });
    const rows = await memoryCheck.measure(ctx, Date.now() + 60_000);
    const file = rows.find((r) => r.key === `memory:file:${path.join(project, "CLAUDE.md")}`);
    expect(file?.severity).toBe("UNKNOWN");
    expect(file?.evidence).toContain("2000 bytes");
    expect(file?.evidence).toContain("tokens UNKNOWN");
    expect(file?.evidence).not.toContain("500");
    expect(rows.find((r) => r.key === "memory:total")?.severity).toBe("UNKNOWN");
  });

  it("refuses a /context run that reports API spend", async () => {
    const { fx } = setup();
    const ctx = makeContext(
      fx,
      {},
      {
        probes: fakeProbes({
          exec: async () => ({
            stdout: JSON.stringify({
              result: "## Context Usage",
              total_cost_usd: 0.4,
              duration_api_ms: 900,
            }),
            stderr: "",
            code: 0,
          }),
        }),
      },
    );
    const rows = await memoryCheck.measure(ctx, Date.now() + 60_000);
    expect(rows.every((r) => r.severity === "UNKNOWN")).toBe(true);
    expect(rows.map((r) => r.evidence).join(" ")).toContain("made an API call");
  });
});

describe("TOOLS", () => {
  const listing = (names: string[]) => ({
    type: "user",
    message: { role: "user", content: `deferred tools now available: ${names.join("\\n")}` },
  });

  it("counts unique tools per server and reports deferral ACTIVE from the deferred-tools listing", async () => {
    const fx = makeFixture();
    withPool(fx);
    const project = projectDir(fx);
    writeTranscript(fx, "-proj", "s1", [
      assistantLine("claude-opus-5-5", "m1", project),
      listing(["mcp__github__a", "mcp__github__b", "mcp__linear__x", "mcp__github__a"]),
      { type: "assistant", message: { content: [{ type: "tool_use", name: "ToolSearch" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__github__a" }] } },
    ]);
    const ctx = makeContext(fx, {}, { probes: fakeProbes({ exec: async () => null }) });
    const rows = await toolsCheck.measure(ctx, Date.now() + 60_000);
    expect(rows.find((r) => r.key === "tools:server:github")?.finding).toContain("2 tools");
    expect(rows.find((r) => r.key === "tools:server:linear")?.finding).toContain("1 tools");
    expect(rows.find((r) => r.key === "tools:total")?.evidence).toContain(
      "3 unique tool names across 2 servers",
    );
    const deferral = rows.find((r) => r.key === "tools:deferral");
    expect(deferral?.finding).toBe("Tool deferral is ACTIVE");
    expect(deferral?.severity).toBe("GREEN");
  });

  it("scans a transcript without counting names that only appear in prose", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tools-scan-"));
    const file = path.join(dir, "s.jsonl");
    writeFileSync(
      file,
      JSON.stringify({ type: "user", message: { content: "call mcp__fake__tool later" } }) + "\n",
    );
    const scan = await scanTranscriptTools(file);
    expect(scan.servers.size).toBe(0);
  });

  it("is RED when there is no deferral, and RED again when a proxy variable is set; secrets never appear", async () => {
    const fx = makeFixture();
    withPool(fx);
    const project = projectDir(fx);
    writeTranscript(fx, "-proj", "s1", [
      assistantLine("claude-opus-5-5", "m1", project),
      { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__github__a" }] } },
    ]);
    writeFileSync(
      path.join(fx.home, ".claude-personal", "settings.local.json"),
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://user:hunter2@gateway.example.com/v1?key=abc",
          ANTHROPIC_AUTH_TOKEN: "sk-secret-token-value",
          OPENAI_API_KEY: "sk-openai-secret",
        },
      }),
    );
    const ctx = makeContext(fx, {}, { probes: fakeProbes({ exec: async () => null }) });
    const rows = await toolsCheck.measure(ctx, Date.now() + 60_000);
    expect(rows.find((r) => r.key === "tools:deferral")?.severity).toBe("RED");
    const proxy = rows.find((r) => r.key === "tools:proxy");
    expect(proxy?.severity).toBe("RED");
    expect(proxy?.evidence).toContain("ANTHROPIC_BASE_URL=https://gateway.example.com");
    expect(proxy?.evidence).toContain("ANTHROPIC_AUTH_TOKEN=<redacted>");
    const all = JSON.stringify(rows);
    for (const secret of ["hunter2", "sk-secret-token-value", "sk-openai-secret", "key=abc"]) {
      expect(all).not.toContain(secret);
    }
  });

  it("names an explicit ENABLE_TOOL_SEARCH=false as the reason deferral is off", async () => {
    const fx = makeFixture();
    withPool(fx);
    const project = projectDir(fx);
    writeTranscript(fx, "-proj", "s1", [
      assistantLine("claude-opus-5-5", "m1", project),
      listing(["mcp__a__b"]),
    ]);
    writeFileSync(
      path.join(fx.home, ".claude", "settings.json"),
      JSON.stringify({ env: { ENABLE_TOOL_SEARCH: "false" } }),
    );
    const ctx = makeContext(fx, {}, { probes: fakeProbes({ exec: async () => null }) });
    const rows = await toolsCheck.measure(ctx, Date.now() + 60_000);
    const deferral = rows.find((r) => r.key === "tools:deferral");
    expect(deferral?.finding).toContain("DISABLED by ENABLE_TOOL_SEARCH");
    expect(deferral?.severity).toBe("RED");
  });
});

describe("running agent processes", () => {
  it("reads the launch flags and only the env names that matter, redacting secrets", () => {
    const proc = parseAgentProcess(
      42,
      "/x/claude --output-format stream-json --thinking adaptive --effort xhigh --model claude-opus-5-5 --append-system-prompt use --model gpt",
      "/x/claude --model claude-opus-5-5 CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-5 ANTHROPIC_AUTH_TOKEN=abc123 ANTHROPIC_BASE_URL=https://u:p@h.example/x?y=1 HOME=/Users/x CLAUDE_CONFIG_DIR=/Users/x/.claude-leader",
    );
    expect(proc.model).toBe("claude-opus-5-5");
    expect(proc.effort).toBe("xhigh");
    expect(proc.thinking).toBe("adaptive");
    expect(proc.configDir).toBe("/Users/x/.claude-leader");
    expect(proc.env).toEqual([
      { name: "CLAUDE_CODE_SUBAGENT_MODEL", display: "claude-sonnet-5" },
      { name: "ANTHROPIC_AUTH_TOKEN", display: "<redacted>" },
      { name: "ANTHROPIC_BASE_URL", display: "https://h.example" },
      { name: "CLAUDE_CONFIG_DIR", display: "/Users/x/.claude-leader" },
    ]);
    expect(displayEnvValue("OPENAI_API_KEY", "sk-x")).toBe("<redacted>");
  });
});

describe("MODEL", () => {
  it("flags opusplan and a fallback model as automatic switching and names the file", async () => {
    const fx = makeFixture();
    withPool(fx);
    writeFileSync(
      path.join(fx.home, ".claude-leader", "settings.json"),
      JSON.stringify({ model: "opusplan", effortLevel: "high" }),
    );
    const ctx = makeContext(fx, {}, { probes: fakeProbes({ exec: async () => null }) });
    const rows = await modelCheck.measure(ctx, Date.now() + 60_000);
    const auto = rows.find((r) => r.key === "model:auto-switch");
    expect(auto?.severity).toBe("RED");
    expect(auto?.evidence).toContain(path.join(fx.home, ".claude-leader", "settings.json"));
    const setting = rows.find(
      (r) => r.key === `model:setting:${path.join(fx.home, ".claude-leader")}`,
    );
    expect(setting?.evidence).toContain("model=opusplan set in");
    expect(setting?.evidence).toContain("effortLevel=high");
  });

  it("counts sessions whose main thread changed model, ignoring sub-agents", async () => {
    const fx = makeFixture();
    withPool(fx);
    const project = projectDir(fx);
    writeTranscript(fx, "-proj", "switched", [
      assistantLine("claude-opus-5", "m1", project),
      assistantLine("claude-opus-5-5", "m2", project),
    ]);
    writeTranscript(fx, "-proj", "steady", [
      assistantLine("claude-opus-5-5", "m1", project),
      assistantLine("claude-sonnet-5", "m2", project, { isSidechain: true }),
      assistantLine("claude-opus-5-5", "m3", project),
    ]);
    const ctx = makeContext(fx, {}, { probes: fakeProbes({ exec: async () => null }) });
    const rows = await modelCheck.measure(ctx, Date.now() + 60_000);
    const auto = rows.find((r) => r.key === "model:auto-switch");
    expect(auto?.severity).toBe("AMBER");
    expect(auto?.finding).toBe("1 of 2 recent sessions changed model mid-session");
    expect(auto?.evidence).toContain("claude-opus-5 → claude-opus-5-5");
  });

  it("reports the launch flags of running agents, and UNKNOWN off macOS", async () => {
    const fx = makeFixture();
    withPool(fx);
    const exec: DoctorProbes["exec"] = async (file, args) => {
      if (file !== "ps") return null;
      if (args[0] === "-axww") {
        return {
          stdout:
            "  101 /x/claude --output-format stream-json --thinking adaptive --effort xhigh --model claude-opus-5-5\n  102 /x/claude --output-format stream-json --model claude-opus-5-5 --effort xhigh --thinking adaptive\n",
          stderr: "",
          code: 0,
        };
      }
      return {
        stdout: "/x/claude ... CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-5\n",
        stderr: "",
        code: 0,
      };
    };
    const mac = await modelCheck.measure(
      makeContext(fx, {}, { probes: fakeProbes({ exec }) }),
      Date.now() + 60_000,
    );
    expect(mac.find((r) => r.key === "model:launch")?.evidence).toBe(
      "2 × --model claude-opus-5-5 --effort xhigh --thinking adaptive",
    );
    const win = await modelCheck.measure(
      makeContext(fx, {}, { probes: fakeProbes({ exec }), platform: "win32" }),
      Date.now() + 60_000,
    );
    expect(win.find((r) => r.key === "model:launch")?.severity).toBe("UNKNOWN");
    expect(win.find((r) => r.key === "model:launch")?.evidence).toContain("macOS only");
  });
});

describe("HOOKS", () => {
  it("is GREEN when a PreToolUse hook script rewrites tool input", async () => {
    const fx = makeFixture();
    withPool(fx);
    const script = path.join(fx.home, "rewrite.sh");
    writeFileSync(
      script,
      '#!/bin/sh\necho \'{"hookSpecificOutput":{"updatedInput":{"command":"x | head -50"}}}\'\n',
    );
    writeFileSync(
      path.join(fx.home, ".claude", "settings.json"),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: script }] }] },
      }),
    );
    const rows = await hooksCheck.measure(makeContext(fx), Date.now() + 5000);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.severity).toBe("GREEN");
    expect(rows[0]?.finding).toBe("1 PreToolUse hooks rewrite tool input");
  });

  it("flags a PreToolUse hook that does not rewrite, and having none at all", async () => {
    const fx = makeFixture();
    withPool(fx);
    const none = await hooksCheck.measure(makeContext(fx), Date.now() + 5000);
    expect(none[0]?.severity).toBe("AMBER");
    expect(none[0]?.finding).toBe("No PreToolUse hook exists to rewrite noisy commands");
    const script = path.join(fx.home, "log.sh");
    writeFileSync(script, "#!/bin/sh\necho hi\n");
    writeFileSync(
      path.join(fx.home, ".claude", "settings.json"),
      JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: "command", command: script }] }] },
      }),
    );
    const some = await hooksCheck.measure(makeContext(fx), Date.now() + 5000);
    expect(some[0]?.finding).toBe("1 PreToolUse hooks, none rewrite tool input");
  });

  it("reads installed plugins' hooks.json", async () => {
    const fx = makeFixture();
    withPool(fx);
    const install = path.join(fx.home, ".claude", "plugins", "cache", "p");
    mkdirSync(path.join(install, "hooks"), { recursive: true });
    writeFileSync(path.join(install, "hooks", "rw.sh"), "echo updatedInput\n");
    writeFileSync(
      path.join(install, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/rw.sh" }],
            },
          ],
        },
      }),
    );
    writeFileSync(
      path.join(fx.home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "p@m": [{ installPath: install }] } }),
    );
    const rows = await hooksCheck.measure(makeContext(fx), Date.now() + 5000);
    expect(rows[0]?.severity).toBe("GREEN");
  });
});

describe("SUBAGENTS", () => {
  it("reads the model key from frontmatter", () => {
    expect(readAgentModel("---\nname: a\nmodel: haiku\n---\nbody")).toBe("haiku");
    expect(readAgentModel('---\nname: a\nmodel: "sonnet"\n---\n')).toBe("sonnet");
    expect(readAgentModel("---\nname: a\n---\nmodel: haiku")).toBeNull();
    expect(readAgentModel("no frontmatter")).toBeNull();
  });

  it("flags agents that inherit the caller's model unless the subagent override is set", async () => {
    const fx = makeFixture();
    withPool(fx);
    const agents = path.join(fx.home, ".claude", "agents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(path.join(agents, "reviewer.md"), "---\nname: reviewer\n---\nbody");
    writeFileSync(path.join(agents, "scout.md"), "---\nname: scout\nmodel: haiku\n---\nbody");
    const rows = await subagentsCheck.measure(
      makeContext(fx, {}, { probes: fakeProbes({ exec: async () => null }) }),
      Date.now() + 5000,
    );
    const reviewer = rows.find((r) => r.finding.startsWith("Agent reviewer"));
    expect(reviewer?.severity).toBe("AMBER");
    expect(reviewer?.finding).toBe("Agent reviewer: inherits the caller's model");
    expect(rows.find((r) => r.finding.startsWith("Agent scout"))?.severity).toBe("GREEN");
    expect(rows.find((r) => r.key === "subagents:summary")?.finding).toBe(
      "2 agent files, 1 inherit the caller's model",
    );

    // Every provider sets CLAUDE_CODE_SUBAGENT_MODEL, and no process lacks it: nothing inherits.
    writeConfig(fx, {
      agents: {
        providers: {
          claude: {
            env: {
              CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-5",
              CLAUDE_CONFIG_DIR: path.join(fx.home, ".claude"),
            },
          },
        },
      },
    });
    const covered = await subagentsCheck.measure(
      makeContext(fx, {}, { probes: fakeProbes({ exec: async () => null }) }),
      Date.now() + 5000,
    );
    expect(covered.find((r) => r.finding.startsWith("Agent reviewer"))?.severity).toBe("GREEN");
  });

  it("has no agent files: GREEN with the directories it looked in", async () => {
    const fx = makeFixture();
    withPool(fx);
    const rows = await subagentsCheck.measure(
      makeContext(fx, {}, { probes: fakeProbes({ exec: async () => null }) }),
      Date.now() + 5000,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.finding).toBe("0 agent files, 0 inherit the caller's model");
    expect(rows[0]?.evidence).toContain(path.join(fx.home, ".claude", "agents"));
  });
});

describe("the table and the runner", () => {
  it("renders FINDING | SEVERITY | EVIDENCE | COST and maps severity onto doctor status", () => {
    const rows = [
      row("cache", "cache:a", "GREEN", "fine", "42", "0"),
      row("memory", "memory:a", "RED", "big | file", "13.3k tokens", "13300 tokens"),
      row("model", "model:a", "UNKNOWN", "unknown", "UNKNOWN: x", "UNKNOWN"),
    ];
    expect(renderTokenAuditTable(rows)).toBe(
      [
        "| FINDING | SEVERITY | EVIDENCE | COST |",
        "| --- | --- | --- | --- |",
        "| MEMORY: big \\| file | RED | 13.3k tokens | 13300 tokens |",
        "| MODEL: unknown | UNKNOWN | UNKNOWN: x | UNKNOWN |",
        "| CACHE: fine | GREEN | 42 | 0 |",
      ].join("\n"),
    );
    expect(rows.map((r) => rowToFinding(r).status)).toEqual(["ok", "fail", "skip"]);
    expect(rowToFinding(rows[1] as (typeof rows)[number])).toMatchObject({
      id: "tokens.memory",
      category: "tokens",
      title: "big | file",
      detail: "13.3k tokens",
      why: "13300 tokens",
    });
  });

  it("turns a hung or throwing item into one UNKNOWN row without touching the others", async () => {
    const fx = makeFixture();
    const ctx = makeContext(fx);
    const hung = {
      id: "tokens.tools",
      item: "tools" as const,
      timeoutMs: 20,
      measure: () => new Promise<never>(() => undefined),
    };
    const broken = {
      id: "tokens.hooks",
      item: "hooks" as const,
      timeoutMs: 1000,
      measure: async () => {
        throw new Error("boom");
      },
    };
    const fine = {
      id: "tokens.model",
      item: "model" as const,
      timeoutMs: 1000,
      measure: async () => [row("model", "model:x", "GREEN", "ok", "1", "0")],
    };
    const rows = await runTokenAudit(ctx, [hung, broken, fine]);
    expect(rows.map((r) => [r.key, r.severity])).toEqual([
      ["tools:timeout", "UNKNOWN"],
      ["hooks:failed", "UNKNOWN"],
      ["model:x", "GREEN"],
    ]);
    expect(rows[0]?.evidence).toContain("did not finish within 0s");
    expect(await runTokenAuditCheck(fine, ctx)).toHaveLength(1);
  });

  it("registers one check per item in table order", () => {
    expect(TOKEN_AUDIT_CHECKS.map((c) => c.item)).toEqual([
      "memory",
      "tools",
      "model",
      "hooks",
      "subagents",
      "scheduled",
      "cache",
    ]);
  });
});
