import { expect, test } from "vitest";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DaemonClient } from "./test-utils/index.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import type { PersistedWorkspaceRecord } from "./workspace-registry.js";

async function readWorkspace(
  paseoHome: string,
  workspaceId: string,
): Promise<PersistedWorkspaceRecord> {
  const raw = await readFile(path.join(paseoHome, "projects", "workspaces.json"), "utf8");
  const records = JSON.parse(raw) as PersistedWorkspaceRecord[];
  const record = records.find((entry) => entry.workspaceId === workspaceId);
  if (!record) {
    throw new Error(`Workspace ${workspaceId} is missing from the registry file`);
  }
  return record;
}

// Renaming through the real daemon is the only place provenance is observable
// end to end: the wire has no titleSource field, so the registry file on disk is
// what the tracker later reads to decide whether it may rewrite a name.
test("a rename through a real daemon records who named the workspace", async () => {
  const daemon = await createTestPaseoDaemon();
  const projectRoot = await mkdtemp(path.join(tmpdir(), "paseo-title-provenance-"));
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    await client.connect();
    const created = await client.createWorkspace({
      source: { kind: "directory", path: projectRoot },
    });
    const workspaceId = created.workspace?.id;
    expect(workspaceId).toBeTruthy();
    if (!workspaceId) return;

    // Nobody has named it, and nothing claims to have.
    const untitled = await readWorkspace(daemon.paseoHome, workspaceId);
    expect(untitled.title).toBeNull();
    expect(untitled.titleSource).toBeUndefined();

    await client.setWorkspaceTitle(workspaceId, "Terminal latency pipeline");
    expect(await readWorkspace(daemon.paseoHome, workspaceId)).toMatchObject({
      title: "Terminal latency pipeline",
      titleSource: "manual",
    });

    // Clearing the name hands naming back to Paseo.
    await client.setWorkspaceTitle(workspaceId, null);
    expect(await readWorkspace(daemon.paseoHome, workspaceId)).toMatchObject({
      title: null,
      titleSource: "auto",
    });

    // A title typed into the app's create form is a person's; the same request made for an
    // agent (a CLI run under PASEO_AGENT_ID) is the agent's, which Paseo may refresh later.
    const typed = await client.createWorkspace({
      source: { kind: "directory", path: projectRoot },
      title: "Typed by a person",
    });
    expect(await readWorkspace(daemon.paseoHome, typed.workspace!.id)).toMatchObject({
      title: "Typed by a person",
      titleSource: "manual",
    });
    const agentNamed = await client.createWorkspace({
      source: { kind: "directory", path: projectRoot },
      title: "Named by an agent",
      callerAgentId: "agent-fake-do-not-use",
    });
    expect(await readWorkspace(daemon.paseoHome, agentNamed.workspace!.id)).toMatchObject({
      title: "Named by an agent",
      titleSource: "auto",
    });
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
}, 180000);
