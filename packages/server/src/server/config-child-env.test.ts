import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig } from "./config.js";

const roots: string[] = [];

async function createPaseoHome(config: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-config-child-env-"));
  roots.push(root);
  const paseoHome = path.join(root, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  await writeFile(path.join(paseoHome, "config.json"), JSON.stringify(config, null, 2));
  return paseoHome;
}

describe("agents.childEnv config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("the strip list reaches the running config", async () => {
    const home = await createPaseoHome({
      version: 1,
      agents: { childEnv: { strip: ["BIBLIO_*", "CLAUDE_CODE_OAUTH_TOKEN"] } },
    });
    expect(loadConfig(home).childEnvStrip).toEqual(["BIBLIO_*", "CLAUDE_CODE_OAUTH_TOKEN"]);
  });

  test("absent means the default list", async () => {
    const home = await createPaseoHome({ version: 1 });
    expect(loadConfig(home).childEnvStrip).toBeUndefined();
  });
});
