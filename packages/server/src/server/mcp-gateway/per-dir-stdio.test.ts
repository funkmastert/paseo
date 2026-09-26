import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { findPerDirMcpServer, readPerDirStdioMcpServers } from "./per-dir-stdio.js";

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

describe("findPerDirMcpServer", () => {
  test("finds a user-scope http entry and expands ${VAR} in url and headers", () => {
    const configDir = createTempDir("paseo-claude-config-");
    const projectDir = createTempDir("paseo-project-");
    process.env.PASEO_TEST_ZEEQ_REPO = "wonderly/prompts";
    try {
      writeFileSync(
        path.join(configDir, ".claude.json"),
        JSON.stringify({
          mcpServers: {
            zeeq: {
              type: "http",
              url: "https://app.zeeq.ai/mcp",
              headers: { "x-zeeq-prompts-repo": "${PASEO_TEST_ZEEQ_REPO}" },
            },
          },
        }),
      );

      expect(findPerDirMcpServer({ configDir, projectDir, name: "zeeq" })).toEqual({
        kind: "remote",
        server: {
          url: "https://app.zeeq.ai/mcp",
          transport: "http",
          headers: { "x-zeeq-prompts-repo": "wonderly/prompts" },
        },
      });
    } finally {
      delete process.env.PASEO_TEST_ZEEQ_REPO;
    }
  });

  test("project .mcp.json beats user scope, and a url with no type reads as http", () => {
    const configDir = createTempDir("paseo-claude-config-");
    const projectDir = createTempDir("paseo-project-");
    writeFileSync(
      path.join(configDir, ".claude.json"),
      JSON.stringify({
        mcpServers: { notion: { type: "http", url: "https://user.example/mcp" } },
      }),
    );
    writeFileSync(
      path.join(projectDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { notion: { url: "https://project.example/mcp" } } }),
    );

    expect(findPerDirMcpServer({ configDir, projectDir, name: "notion" })).toEqual({
      kind: "remote",
      server: { url: "https://project.example/mcp", transport: "http" },
    });
  });

  test("local scope beats the checked-in project .mcp.json, matching the CLI's precedence", () => {
    // The user's private override must win over whatever a repository ships; adopting the
    // checked-in copy would broker a definition the session isn't actually using.
    const configDir = createTempDir("paseo-claude-config-");
    const projectDir = createTempDir("paseo-project-");
    writeFileSync(
      path.join(configDir, ".claude.json"),
      JSON.stringify({
        mcpServers: { notion: { type: "http", url: "https://user.example/mcp" } },
        projects: {
          [projectDir]: {
            mcpServers: { notion: { type: "sse", url: "https://local.example/mcp" } },
          },
        },
      }),
    );
    writeFileSync(
      path.join(projectDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { notion: { url: "https://project.example/mcp" } } }),
    );

    expect(findPerDirMcpServer({ configDir, projectDir, name: "notion" })).toEqual({
      kind: "remote",
      server: { url: "https://local.example/mcp", transport: "sse" },
    });
  });

  test("expands ${VAR} against the env the session runs with, not only the daemon's", () => {
    const configDir = createTempDir("paseo-claude-config-");
    const projectDir = createTempDir("paseo-project-");
    writeFileSync(
      path.join(projectDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          zeeq: {
            type: "http",
            url: "https://app.zeeq.ai/mcp",
            headers: { Authorization: "Bearer ${ZEEQ_TOKEN_FOR_TEST}" },
          },
        },
      }),
    );
    delete process.env.ZEEQ_TOKEN_FOR_TEST;

    expect(
      findPerDirMcpServer({
        configDir,
        projectDir,
        name: "zeeq",
        env: { ZEEQ_TOKEN_FOR_TEST: "from-provider-profile" },
      }),
    ).toMatchObject({
      server: { headers: { Authorization: "Bearer from-provider-profile" } },
    });
    // Without the session env the daemon's own env is used, where the token is unset.
    expect(findPerDirMcpServer({ configDir, projectDir, name: "zeeq" })).toMatchObject({
      server: { headers: { Authorization: "Bearer " } },
    });
  });

  test("tells a local entry apart from an absent one", () => {
    const configDir = createTempDir("paseo-claude-config-");
    const projectDir = createTempDir("paseo-project-");
    writeFileSync(
      path.join(configDir, ".claude.json"),
      JSON.stringify({ mcpServers: { "local-fs": { type: "stdio", command: "fs-tool" } } }),
    );

    expect(findPerDirMcpServer({ configDir, projectDir, name: "local-fs" })).toEqual({
      kind: "local",
    });
    expect(findPerDirMcpServer({ configDir, projectDir, name: "nope" })).toEqual({
      kind: "absent",
    });
  });

  test("the first scope that names the server decides, even when its entry is local", () => {
    // Same precedence rule as a remote override: falling through to user scope would broker a
    // definition the session is not using.
    const configDir = createTempDir("paseo-claude-config-");
    const projectDir = createTempDir("paseo-project-");
    writeFileSync(
      path.join(configDir, ".claude.json"),
      JSON.stringify({
        mcpServers: { notion: { type: "http", url: "https://user.example/mcp" } },
        projects: {
          [projectDir]: { mcpServers: { notion: { type: "stdio", command: "notion-local" } } },
        },
      }),
    );

    expect(findPerDirMcpServer({ configDir, projectDir, name: "notion" })).toEqual({
      kind: "local",
    });
  });
});
