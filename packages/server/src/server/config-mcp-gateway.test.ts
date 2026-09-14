import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadConfig } from "./config.js";

const roots: string[] = [];

async function createPaseoHome(config: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-config-mcp-gateway-"));
  roots.push(root);
  const paseoHome = path.join(root, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  await writeFile(path.join(paseoHome, "config.json"), JSON.stringify(config, null, 2));
  return paseoHome;
}

describe("daemon MCP gateway config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("leaves the gateway unconfigured when the section is absent", async () => {
    const home = await createPaseoHome({ version: 1 });

    expect(loadConfig(home, { env: {} }).mcpGateway).toBeUndefined();
  });

  // bootstrap.ts constructs McpGateway from `config.mcpGateway`. The gateway e2e tests hand
  // that field in directly, so a real daemon booting with the section on disk was the only
  // path that exercised this mapping — and it was missing, leaving the gateway disabled.
  test("carries the persisted mcpGateway section into the daemon config", async () => {
    const mcpGateway = {
      enabled: true,
      sessionMode: "strict",
      servers: {
        zeeq: { url: "https://zeeq.example.test/mcp", transport: "http", critical: true },
        github: { url: "https://github.example.test/mcp", transport: "sse" },
      },
    };
    const home = await createPaseoHome({ version: 1, mcpGateway });

    expect(loadConfig(home, { env: {} }).mcpGateway).toEqual(mcpGateway);
  });
});
