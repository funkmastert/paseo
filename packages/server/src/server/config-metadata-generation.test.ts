import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createInitialMutableDaemonConfig } from "./bootstrap.js";
import { loadConfig } from "./config.js";

const roots: string[] = [];

async function createPaseoHome(config: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-config-metadata-generation-"));
  roots.push(root);
  const paseoHome = path.join(root, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  await writeFile(path.join(paseoHome, "config.json"), JSON.stringify(config, null, 2));
  return paseoHome;
}

describe("metadata generation config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("both tracker sections survive the trip from config.json into the running config", async () => {
    const home = await createPaseoHome({
      version: 1,
      agents: {
        metadataGeneration: {
          titleTracking: { refreshIntervalMinutes: 15 },
          workspaceTitleTracking: { enabled: false, activityWindowMinutes: 120 },
        },
      },
    });

    const mutable = createInitialMutableDaemonConfig(loadConfig(home));

    expect(mutable.metadataGeneration).toEqual({
      providers: [],
      titleTracking: { refreshIntervalMinutes: 15 },
      workspaceTitleTracking: { enabled: false, activityWindowMinutes: 120 },
    });
  });

  test("an absent section leaves the running config with providers alone", async () => {
    const home = await createPaseoHome({ version: 1 });

    const mutable = createInitialMutableDaemonConfig(loadConfig(home));

    expect(mutable.metadataGeneration).toEqual({ providers: [] });
  });
});
