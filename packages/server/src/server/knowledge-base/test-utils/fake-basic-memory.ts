import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * A stand-in for the `basic-memory` command line, run by Node from a temp directory: it answers
 * `--version`, `project add|remove` (keeping Basic Memory's `config.json` shape under
 * BASIC_MEMORY_CONFIG_DIR) and `mcp`, a real stdio MCP server. It requires the SDK by absolute
 * path, so it runs from outside the repo the way the real tool does.
 *
 * Tools: `search_notes` answers from `setSearchResults`, waits 5 s for the query "slow", fails
 * for "broken" and returns plain text for "not-json"; `env` reports the named variables it
 * sees; `exit` exits with code 1.
 */

export interface FakeBasicMemoryCall {
  argv?: string[];
  tool?: string;
  input?: Record<string, unknown>;
  cwd: string;
}

export interface FakeBasicMemory {
  /** The configured command: a wrapper that runs the fake with Node. */
  command: string;
  binDir: string;
  calls(): FakeBasicMemoryCall[];
  setSearchResults(resultsByQuery: Record<string, unknown[]>): void;
  /** While set, `mcp` writes to stderr and exits 3 before serving. */
  failStarts(fail: boolean): void;
  /** Exit code for `project add` of a project that exists. The real 0.23.2 exits 0. */
  setExistsExitCode(code: number): void;
  /** Writes the fake as files named `project` and `mcp`, for `linkNodeAs`. */
  writeEntryScripts(dir: string): void;
}

function fakeProgram(binDir: string): string {
  const require = createRequire(import.meta.url);
  const mcp = require.resolve("@modelcontextprotocol/sdk/server/mcp.js");
  const stdio = require.resolve("@modelcontextprotocol/sdk/server/stdio.js");
  const zod = require.resolve("zod");
  return `
const fs = require("node:fs");
const path = require("node:path");
const FAKE_DIR = ${JSON.stringify(binDir)};
const entry = path.basename(process.argv[1] || "");
const args = entry === "project" || entry === "mcp" ? [entry, ...process.argv.slice(2)] : process.argv.slice(2);
function log(record) {
  fs.appendFileSync(path.join(FAKE_DIR, "calls.jsonl"), JSON.stringify({ ...record, cwd: process.cwd() }) + "\\n");
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
log({ argv: args });
if (args[0] === "--version") {
  console.log("Basic Memory version: 0.23.2");
  process.exit(0);
}
if (args[0] === "project") {
  const configPath = path.join(process.env.BASIC_MEMORY_CONFIG_DIR, "config.json");
  const config = readJson(configPath, { projects: {} });
  const name = args[2];
  if (args[1] === "add") {
    if (config.projects[name]) {
      console.log("Project '" + name + "' already exists");
      process.exit(Number(readJson(path.join(FAKE_DIR, "exists-exit-code.json"), 0)));
    }
    config.projects[name] = { path: args[3], mode: "local" };
    fs.writeFileSync(configPath, JSON.stringify(config));
    console.log("Project '" + name + "' added successfully");
    process.exit(0);
  }
  if (args[1] === "remove") {
    delete config.projects[name];
    fs.writeFileSync(configPath, JSON.stringify(config));
    process.exit(0);
  }
  process.exit(2);
}
if (args[0] !== "mcp") process.exit(2);
if (fs.existsSync(path.join(FAKE_DIR, "fail-start"))) {
  process.stderr.write("fake: starting\\nfake: database is locked\\n");
  process.exit(3);
}
const { McpServer } = require(${JSON.stringify(mcp)});
const { StdioServerTransport } = require(${JSON.stringify(stdio)});
const { z } = require(${JSON.stringify(zod)});
process.stderr.write("fake: serving\\n");
const server = new McpServer({ name: "Basic Memory", version: "fake" });
server.registerTool(
  "search_notes",
  {
    description: "Search",
    inputSchema: {
      query: z.string(),
      page_size: z.number().optional(),
      output_format: z.string().optional(),
      search_type: z.string().optional(),
      note_types: z.array(z.string()).optional(),
      min_similarity: z.number().optional(),
    },
  },
  async (input) => {
    log({ tool: "search_notes", input });
    if (input.query === "slow") await new Promise((resolve) => setTimeout(resolve, 5000));
    if (input.query === "broken") {
      return { isError: true, content: [{ type: "text", text: "Semantic search is disabled" }] };
    }
    if (input.query === "not-json") return { content: [{ type: "text", text: "plain words" }] };
    const results = readJson(path.join(FAKE_DIR, "results.json"), {})[input.query] || [];
    const payload = { results, current_page: 1, page_size: input.page_size, total: results.length, has_more: false };
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
  },
);
server.registerTool("env", { description: "Reports env", inputSchema: { names: z.array(z.string()) } }, async ({ names }) => ({
  content: [{ type: "text", text: JSON.stringify(Object.fromEntries(names.map((n) => [n, process.env[n] ?? null]))) }],
}));
server.registerTool("exit", { description: "Exits", inputSchema: {} }, async () => {
  setTimeout(() => process.exit(1), 10);
  return { content: [] };
});
// Basic Memory exits when its stdin closes.
process.stdin.on("end", () => process.exit(0));
void server.connect(new StdioServerTransport());
`;
}

/** `name` is the wrapper's file name, `basic-memory` unless a test needs one PATH cannot hold. */
export function writeFakeBasicMemory(binDir: string, name = "basic-memory"): FakeBasicMemory {
  mkdirSync(binDir, { recursive: true });
  const program = fakeProgram(binDir);
  const script = path.join(binDir, "fake-basic-memory.cjs");
  writeFileSync(script, program);
  let command: string;
  if (process.platform === "win32") {
    command = path.join(binDir, `${name}.cmd`);
    writeFileSync(command, `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    command = path.join(binDir, name);
    writeFileSync(command, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(command, 0o755);
  }
  const callsPath = path.join(binDir, "calls.jsonl");
  return {
    command,
    binDir,
    calls: () =>
      existsSync(callsPath)
        ? readFileSync(callsPath, "utf8")
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line) as FakeBasicMemoryCall)
        : [],
    setSearchResults: (resultsByQuery) =>
      writeFileSync(path.join(binDir, "results.json"), JSON.stringify(resultsByQuery)),
    failStarts: (fail) => {
      const marker = path.join(binDir, "fail-start");
      if (fail) writeFileSync(marker, "");
      else rmSync(marker, { force: true });
    },
    setExistsExitCode: (code) =>
      writeFileSync(path.join(binDir, "exists-exit-code.json"), JSON.stringify(code)),
    writeEntryScripts: (dir) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "project"), program);
      writeFileSync(path.join(dir, "mcp"), program);
    },
  };
}

/**
 * Node itself under the name `basic-memory` (`basic-memory.exe` on Windows) in `dir`, which may
 * contain spaces. Run with the working directory holding `writeEntryScripts`, it serves as the
 * fake: `basic-memory mcp ...` makes Node load the file named `mcp`.
 */
export function linkNodeAs(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, process.platform === "win32" ? "basic-memory.exe" : "basic-memory");
  if (process.platform === "win32") {
    try {
      linkSync(process.execPath, target);
    } catch {
      copyFileSync(process.execPath, target);
    }
  } else {
    symlinkSync(process.execPath, target);
  }
  return target;
}
