import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { readPerDirStdioMcpServers } from "./per-dir-stdio.js";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("readPerDirStdioMcpServers", () => {
  test("reads stdio entries from the global .claude.json and the project .mcp.json", () => {
    const configDir = createTempDir("paseo-claude-config-");
    const projectDir = createTempDir("paseo-project-");

    writeFileSync(
      path.join(configDir, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "global-tool": { type: "stdio", command: "global-tool-bin", args: ["--flag"] },
        },
      }),
    );
    writeFileSync(
      path.join(projectDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "project-tool": { type: "stdio", command: "./scripts/tool.sh" },
        },
      }),
    );

    const result = readPerDirStdioMcpServers({ configDir, projectDir });

    expect(result).toEqual({
      "global-tool": { type: "stdio", command: "global-tool-bin", args: ["--flag"] },
      "project-tool": { type: "stdio", command: "./scripts/tool.sh" },
    });
  });

  test("ignores remote (http/sse) per-dir entries — those are the gateway's job", () => {
    const configDir = createTempDir("paseo-claude-config-");
    const projectDir = createTempDir("paseo-project-");

    writeFileSync(
      path.join(configDir, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          github: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
          "local-tool": { type: "stdio", command: "local-tool-bin" },
        },
      }),
    );

    const result = readPerDirStdioMcpServers({ configDir, projectDir });

    expect(result).toEqual({
      "local-tool": { type: "stdio", command: "local-tool-bin" },
    });
  });

  test("project entries win over global entries on name collision", () => {
    const configDir = createTempDir("paseo-claude-config-");
    const projectDir = createTempDir("paseo-project-");

    writeFileSync(
      path.join(configDir, ".claude.json"),
      JSON.stringify({ mcpServers: { tool: { type: "stdio", command: "global-version" } } }),
    );
    writeFileSync(
      path.join(projectDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { tool: { type: "stdio", command: "project-version" } } }),
    );

    const result = readPerDirStdioMcpServers({ configDir, projectDir });

    expect(result.tool).toEqual({ type: "stdio", command: "project-version" });
  });

  test("expands ${VAR} references in command, args, and env for spawn-semantics parity", () => {
    const configDir = createTempDir("paseo-claude-config-");
    const projectDir = createTempDir("paseo-project-");
    process.env.PASEO_TEST_MCP_STDIO_TOKEN = "secret-value";

    try {
      writeFileSync(
        path.join(projectDir, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            tool: {
              type: "stdio",
              command: "./scripts/tool.sh",
              args: ["--token=${PASEO_TEST_MCP_STDIO_TOKEN}"],
              env: {
                TOKEN: "${PASEO_TEST_MCP_STDIO_TOKEN}",
                FALLBACK: "${PASEO_TEST_MCP_STDIO_UNSET:-defaulted}",
              },
            },
          },
        }),
      );

      const result = readPerDirStdioMcpServers({ configDir, projectDir });

      expect(result.tool).toEqual({
        type: "stdio",
        command: "./scripts/tool.sh",
        args: ["--token=secret-value"],
        env: { TOKEN: "secret-value", FALLBACK: "defaulted" },
      });
    } finally {
      delete process.env.PASEO_TEST_MCP_STDIO_TOKEN;
    }
  });

  test("returns an empty object when neither file exists", () => {
    const configDir = createTempDir("paseo-claude-config-");
    const projectDir = createTempDir("paseo-project-");

    expect(readPerDirStdioMcpServers({ configDir, projectDir })).toEqual({});
  });

  test("fails open (never throws) on malformed JSON", () => {
    const configDir = createTempDir("paseo-claude-config-");
    const projectDir = createTempDir("paseo-project-");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, ".claude.json"), "{not valid json");

    expect(() => readPerDirStdioMcpServers({ configDir, projectDir })).not.toThrow();
    expect(readPerDirStdioMcpServers({ configDir, projectDir })).toEqual({});
  });
});
