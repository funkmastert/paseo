import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AssignmentsStore, assignmentsFilePath } from "./assignments.js";

let notesDir: string;
let filePath: string;

beforeEach(async () => {
  notesDir = await fs.mkdtemp(path.join(os.tmpdir(), "kb-assignments-"));
  filePath = assignmentsFilePath(notesDir);
});

afterEach(async () => {
  await fs.rm(notesDir, { recursive: true, force: true });
});

async function load(): Promise<AssignmentsStore> {
  return await AssignmentsStore.load({ filePath, logger: createTestLogger() });
}

const snapshot = {
  project: "checkout-redesign",
  text: "Knowledge-base project for this session: Checkout redesign.",
  takenAt: "2026-10-08T12:00:00.000Z",
};

describe("AssignmentsStore", () => {
  test("a missing file starts empty and writes nothing until something changes", async () => {
    const store = await load();

    expect(store.getSnapshot("agent-a")).toBeNull();
    expect(store.getWorkspaceProject("ws-1")).toBeNull();
    await expect(fs.stat(filePath)).rejects.toThrow();
  });

  test("snapshots and workspace tags survive a reload", async () => {
    const store = await load();
    await store.setSnapshot("agent-a", snapshot);
    await store.tagWorkspace("ws-1", { project: "checkout-redesign", taggedAt: snapshot.takenAt });

    const reloaded = await load();

    expect(reloaded.getSnapshot("agent-a")).toEqual(snapshot);
    expect(reloaded.getWorkspaceProject("ws-1")).toBe("checkout-redesign");
  });

  test("a tagged workspace keeps its first project", async () => {
    const store = await load();
    const taggedAt = snapshot.takenAt;

    expect(await store.tagWorkspace("ws-1", { project: "checkout-redesign", taggedAt })).toBe(true);
    expect(await store.tagWorkspace("ws-1", { project: "search-ranking", taggedAt })).toBe(false);
    expect(store.getWorkspaceProject("ws-1")).toBe("checkout-redesign");
  });

  test("retargeting a project moves its snapshots and workspace tags and leaves others alone", async () => {
    const store = await load();
    await store.setSnapshot("agent-a", snapshot);
    await store.setSnapshot("agent-b", { ...snapshot, project: "search-ranking" });
    await store.tagWorkspace("ws-1", { project: "checkout-redesign", taggedAt: snapshot.takenAt });

    await store.retargetProject({ from: "checkout-redesign", to: "checkout-revamp" });
    const reloaded = await load();

    expect(reloaded.getSnapshot("agent-a")).toEqual({ ...snapshot, project: "checkout-revamp" });
    expect(reloaded.getSnapshot("agent-b")?.project).toBe("search-ranking");
    expect(reloaded.getWorkspaceProject("ws-1")).toBe("checkout-revamp");
  });

  test("concurrent changes all land", async () => {
    const store = await load();

    await Promise.all(["a", "b", "c", "d"].map((id) => store.setSnapshot(`agent-${id}`, snapshot)));
    const reloaded = await load();

    expect(["a", "b", "c", "d"].map((id) => reloaded.getSnapshot(`agent-${id}`))).toEqual([
      snapshot,
      snapshot,
      snapshot,
      snapshot,
    ]);
  });

  test("a file that does not match the schema is moved aside and the store starts empty", async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ version: 1, agents: { "agent-a": "nope" } }));

    const store = await load();

    expect(store.getSnapshot("agent-a")).toBeNull();
    const entries = await fs.readdir(path.dirname(filePath));
    expect(entries.filter((name) => name.startsWith("assignments.json.corrupt-"))).toHaveLength(1);
    expect(entries).not.toContain("assignments.json");
  });
});
