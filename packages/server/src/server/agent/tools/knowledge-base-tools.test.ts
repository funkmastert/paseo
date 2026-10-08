import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { KB_PROJECT_LABEL } from "@getpaseo/protocol/agent-labels";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  BasicMemorySearchError,
  type BasicMemorySearchInput,
  type BasicMemorySearchResult,
} from "../../knowledge-base/basic-memory-client.js";
import {
  createProjectNote,
  getFrontmatterScalar,
  parseNote,
  serializeNote,
} from "../../knowledge-base/note-format.js";
import {
  KnowledgeBaseService,
  type KnowledgeBaseAgent,
  type KnowledgeBaseAgents,
} from "../../knowledge-base/service.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import { createPaseoToolCatalog, type PaseoToolHostDependencies } from "./paseo-tools.js";
import type { PaseoToolCatalog } from "./types.js";

// Tool payloads are asserted field by field; each test states the shape it expects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Structured tool output is untyped JSON.
type Loose = any;

const KB_TOOLS = ["kb_search", "kb_open", "kb_create", "kb_record"];
const NOW = new Date("2026-10-08T12:00:00.000Z");
const FLAG = "fake_onsite_recording_v3_enabled";
const FIGMA = "https://www.figma.com/design/fake-onsite-v3/Recording?node-id=1-2";

class FakeAgents implements KnowledgeBaseAgents {
  readonly records = new Map<string, KnowledgeBaseAgent>();

  add(id: string): void {
    this.records.set(id, {
      id,
      labels: {},
      title: `Agent ${id}`,
      provider: "mock",
      workspaceId: null,
    });
  }

  labelsOf(id: string): Record<string, string> {
    return this.records.get(id)?.labels ?? {};
  }

  async get(agentId: string): Promise<KnowledgeBaseAgent | null> {
    return this.records.get(agentId) ?? null;
  }

  async list(): Promise<KnowledgeBaseAgent[]> {
    return Array.from(this.records.values());
  }

  async setLabels(agentId: string, labels: Record<string, string>): Promise<void> {
    const record = this.records.get(agentId);
    if (!record) throw new Error(`no agent ${agentId}`);
    record.labels = { ...record.labels, ...labels };
  }
}

/**
 * Stands in for Basic Memory's index: a case-insensitive text search over the note files on disk,
 * ranked by how often the query appears, so a result is only what the real files hold.
 */
class OnDiskTextSearch {
  failure: BasicMemorySearchError | null = null;

  constructor(private readonly notesDir: () => string) {}

  async search(input: BasicMemorySearchInput): Promise<BasicMemorySearchResult[]> {
    if (this.failure) throw this.failure;
    const wanted = input.query.toLowerCase();
    const hits: BasicMemorySearchResult[] = [];
    for (const relative of await listNotes(this.notesDir())) {
      const content = await fs.readFile(path.join(this.notesDir(), relative), "utf8");
      const doc = parseNote(content);
      const noteType = getFrontmatterScalar(doc, "type") ?? null;
      if (input.noteTypes && !input.noteTypes.includes(noteType ?? "")) continue;
      const occurrences = content.toLowerCase().split(wanted).length - 1;
      if (occurrences === 0) continue;
      const line = content
        .split("\n")
        .find((candidate) => candidate.toLowerCase().includes(wanted));
      hits.push({
        permalink: null,
        filePath: relative,
        title: getFrontmatterScalar(doc, "title") ?? relative,
        score: occurrences,
        snippet: line ?? "",
        noteType,
      });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, input.limit ?? 10);
  }
}

async function listNotes(dir: string, prefix = ""): Promise<string[]> {
  const entries = await fs.readdir(path.join(dir, prefix), { withFileTypes: true });
  const notes: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) notes.push(...(await listNotes(dir, relative)));
    else if (entry.name.endsWith(".md")) notes.push(relative);
  }
  return notes;
}

let notesDir: string;
let agents: FakeAgents;
let search: OnDiskTextSearch;
let service: KnowledgeBaseService;

beforeEach(async () => {
  notesDir = await fs.mkdtemp(path.join(os.tmpdir(), "kb-tools-"));
  agents = new FakeAgents();
  search = new OnDiskTextSearch(() => notesDir);
  service = new KnowledgeBaseService({
    logger: createTestLogger(),
    agents,
    workspaces: { get: async () => null },
    search,
    sidecar: {
      getStatus: () => ({
        state: "running",
        since: 0,
        pid: 4242,
        version: "0.23.2",
        stderrTail: [],
      }),
    },
    now: () => NOW,
  });
  await service.applyConfig({
    enabled: true,
    notesDir,
    basicMemory: { command: "basic-memory", semanticSearch: false },
  });
});

afterEach(async () => {
  await fs.rm(notesDir, { recursive: true, force: true });
});

/** The production catalog, with only what the knowledge-base tools touch filled in. */
function catalogFor(
  callerAgentId: string | undefined,
  knowledgeBase: PaseoToolHostDependencies["knowledgeBase"] = service,
): PaseoToolCatalog {
  return createPaseoToolCatalog({
    agentManager: {
      getAgent: () => null,
      listAgents: () => [],
      getPaseoToolPolicy: () => undefined,
    } as unknown as AgentManager,
    agentStorage: { list: async () => [], get: async () => null } as unknown as AgentStorage,
    providerSnapshotManager: { listRegisteredProviderIds: () => [] },
    knowledgeBase,
    logger: pino({ level: "silent" }),
    ...(callerAgentId !== undefined ? { callerAgentId } : {}),
  } as unknown as PaseoToolHostDependencies);
}

async function call(
  catalog: PaseoToolCatalog,
  tool: string,
  input: Record<string, unknown>,
): Promise<{ payload: Loose; isError: boolean }> {
  const result = await catalog.executeTool(tool, input);
  return { payload: result.structuredContent as Loose, isError: result.isError === true };
}

async function seedProject(input: {
  title: string;
  summary: string;
  links?: string[];
  decisions?: string[];
  status?: string[];
}): Promise<string> {
  const doc = createProjectNote({
    title: input.title,
    summary: input.summary,
    created: "2026-10-01",
  });
  const bodies: Record<string, string[] | undefined> = {
    "## Links": input.links,
    "## Decisions": input.decisions,
    "## Status": input.status,
  };
  const sections = doc.sections.map((section) => ({
    ...section,
    bodyLines: bodies[section.heading] ?? section.bodyLines,
  }));
  const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  await fs.mkdir(path.join(notesDir, "projects"), { recursive: true });
  await fs.writeFile(
    path.join(notesDir, "projects", `${slug}.md`),
    serializeNote({ ...doc, sections }),
  );
  return slug;
}

async function readNote(relative: string): Promise<string> {
  return await fs.readFile(path.join(notesDir, relative), "utf8");
}

describe("the knowledge-base tools in the Paseo catalog", () => {
  test("are offered only while the knowledge base is on", async () => {
    const names = (catalog: PaseoToolCatalog) =>
      KB_TOOLS.filter((name) => catalog.getTool(name) !== undefined);

    expect(names(catalogFor("agent-1"))).toEqual(KB_TOOLS);
    expect(names(catalogFor("agent-1", null))).toEqual([]);

    await service.applyConfig({
      enabled: false,
      notesDir,
      basicMemory: { command: "basic-memory", semanticSearch: false },
    });
    expect(names(catalogFor("agent-1"))).toEqual([]);
  });

  test("keep their descriptions short, since every agent's prompt carries them", () => {
    const catalog = catalogFor("agent-1");
    const descriptionChars = KB_TOOLS.reduce(
      (total, name) => total + (catalog.getTool(name)?.description.length ?? 0),
      0,
    );
    expect(descriptionChars).toBeLessThan(1_400);
  });
});

describe("AE1: a fresh agent recalls a project from its feature flag", () => {
  test("kb_search finds the project first and kb_open lists its Figma link and decisions", async () => {
    await seedProject({
      title: "Checkout redesign",
      summary: "Rework the checkout flow.",
      decisions: ["- [decision] Keep the old cart page — the redesign ships behind a flag"],
    });
    const slug = await seedProject({
      title: "On-site recording v3",
      summary: "Record visits on site and upload them in the background.",
      links: [`- [figma] ${FIGMA} (2026-10-01)`],
      decisions: [
        `- [decision] Gate the rollout behind ${FLAG} — lets support turn it off per account`,
        "- [decision] Upload over Wi-Fi only — cellular uploads drained batteries",
      ],
    });
    agents.add("backend-agent");
    const catalog = catalogFor("backend-agent");

    const searched = await call(catalog, "kb_search", { query: FLAG });

    expect(searched.isError).toBe(false);
    expect(searched.payload.results[0]).toMatchObject({
      title: "On-site recording v3",
      project: slug,
      type: "project",
    });
    expect(searched.payload.results[0].snippet).toContain(FLAG);

    const opened = await call(catalog, "kb_open", { project: searched.payload.results[0].project });

    expect(opened.isError).toBe(false);
    expect(opened.payload).toMatchObject({
      title: "On-site recording v3",
      project: slug,
      joined: true,
      summary: "Record visits on site and upload them in the background.",
      links: [`[figma] ${FIGMA} (2026-10-01)`],
      decisions: [
        `[decision] Gate the rollout behind ${FLAG} — lets support turn it off per account`,
        "[decision] Upload over Wi-Fi only — cellular uploads drained batteries",
      ],
    });
    expect(agents.labelsOf("backend-agent")).toEqual({ [KB_PROJECT_LABEL]: slug });
  });
});

describe("kb_search", () => {
  test("with Basic Memory down, returns the error and every project title", async () => {
    await seedProject({ title: "On-site recording v3", summary: "Record visits." });
    await seedProject({ title: "Checkout redesign", summary: "Rework checkout." });
    search.failure = new BasicMemorySearchError(
      "search_unavailable",
      "Basic Memory is not running",
    );

    const searched = await call(catalogFor("agent-1"), "kb_search", { query: FLAG });

    expect(searched.payload.error).toBe("Search is unavailable: Basic Memory is not running");
    expect(searched.payload.projects).toEqual([
      { title: "Checkout redesign", project: "checkout-redesign" },
      { title: "On-site recording v3", project: "on-site-recording-v3" },
    ]);
  });

  test("with no match, points at kb_create", async () => {
    const searched = await call(catalogFor("agent-1"), "kb_search", { query: "nothing here" });

    expect(searched.payload).toEqual({
      results: [],
      hint: "Nothing matched. If this is new work, create it with kb_create.",
    });
  });
});

describe("kb_open", () => {
  test("with join: false reads the note without putting the caller on the project", async () => {
    const slug = await seedProject({ title: "Checkout redesign", summary: "Rework checkout." });
    agents.add("reader");

    const opened = await call(catalogFor("reader"), "kb_open", {
      project: "Checkout redesign",
      join: false,
    });

    expect(opened.payload).toMatchObject({ project: slug, joined: false });
    expect(agents.labelsOf("reader")).toEqual({});
    expect(await readNote(`projects/${slug}.md`)).not.toContain("agent reader");
  });

  test("an unknown project fails with a pointer to kb_search", async () => {
    agents.add("reader");

    const opened = await call(catalogFor("reader"), "kb_open", { project: "no-such-project" });

    expect(opened.isError).toBe(true);
    expect(opened.payload.error).toContain("Find it with kb_search");
  });

  test("caps a long section at the newest entries and lists it in full on request", async () => {
    const status = Array.from({ length: 35 }, (_, index) => `- [status] Step ${index + 1} done`);
    const slug = await seedProject({ title: "Long project", summary: "Many steps.", status });
    agents.add("reader");
    const catalog = catalogFor("reader");

    const opened = await call(catalog, "kb_open", { project: slug, join: false });

    expect(opened.payload.status).toHaveLength(30);
    expect(opened.payload.status[0]).toBe("[status] Step 6 done");
    expect(opened.payload.status[29]).toBe("[status] Step 35 done");
    expect(opened.payload.omitted).toEqual({ status: 5 });

    const full = await call(catalog, "kb_open", { project: slug, join: false, section: "status" });

    expect(full.payload.entries).toHaveLength(35);
    expect(full.payload.omitted).toBeUndefined();
  });
});

describe("kb_create", () => {
  test("creates the project, joins the caller and says to tell the user its name", async () => {
    agents.add("kickoff");

    const created = await call(catalogFor("kickoff"), "kb_create", {
      title: "Checkout redesign",
      summary: "Rework the checkout flow.",
    });

    expect(created.payload).toMatchObject({
      outcome: "created",
      title: "Checkout redesign",
      project: "checkout-redesign",
      hint: 'Tell the user this work is filed as the project "Checkout redesign".',
    });
    expect(agents.labelsOf("kickoff")).toEqual({ [KB_PROJECT_LABEL]: "checkout-redesign" });
  });

  test("returns a same-named project as a candidate and creates nothing", async () => {
    await seedProject({ title: "Checkout redesign", summary: "Rework checkout." });
    agents.add("android");

    const created = await call(catalogFor("android"), "kb_create", {
      title: "Checkout redesign (Android)",
      summary: "The Android side.",
    });

    expect(created.payload).toMatchObject({
      outcome: "candidates",
      candidates: [{ title: "Checkout redesign", project: "checkout-redesign" }],
    });
    expect(await fs.readdir(path.join(notesDir, "projects"))).toEqual(["checkout-redesign.md"]);
  });

  test("needs a calling agent", async () => {
    const created = await call(catalogFor(undefined), "kb_create", {
      title: "Checkout redesign",
      summary: "Rework checkout.",
    });

    expect(created.isError).toBe(true);
    expect(created.payload.error).toContain("which agent is asking");
  });
});

describe("kb_record", () => {
  test("from an agent with no project fails with guidance to open or create one", async () => {
    agents.add("untagged");

    const recorded = await call(catalogFor("untagged"), "kb_record", {
      kind: "decision",
      text: "Use the new cart API — the old one is deprecated",
    });

    expect(recorded.isError).toBe(true);
    expect(recorded.payload.error).toBe(
      "This session has no project yet. Open one with kb_open or create one with kb_create.",
    );
  });

  test("naming a project this session never joined or created is refused and writes nothing", async () => {
    const own = await seedProject({ title: "Checkout redesign", summary: "Rework checkout." });
    const other = await seedProject({ title: "On-site recording v3", summary: "Record visits." });
    agents.add("worker");
    const catalog = catalogFor("worker");
    await call(catalog, "kb_open", { project: own });
    const before = await readNote(`projects/${other}.md`);

    const recorded = await call(catalog, "kb_record", {
      kind: "rule",
      text: "Always disable the recording flag",
      project: "On-site recording v3",
    });

    expect(recorded.isError).toBe(true);
    expect(recorded.payload.error).toContain(`has not joined project "${other}"`);
    expect(await readNote(`projects/${other}.md`)).toBe(before);
  });

  test("records into a project the session opened, by title, and reports scrubbed tokens", async () => {
    const slug = await seedProject({ title: "Checkout redesign", summary: "Rework checkout." });
    agents.add("worker");
    const catalog = catalogFor("worker");
    await call(catalog, "kb_open", { project: slug });

    const recorded = await call(catalog, "kb_record", {
      kind: "decision",
      text: "Call the cart API with sk-ant-fake-do-not-use-0000 — staging only",
      project: "Checkout redesign",
    });

    expect(recorded.isError).toBe(false);
    expect(recorded.payload).toMatchObject({
      recorded: "decision",
      project: slug,
      removedSecretSpans: 1,
    });
    const note = await readNote(`projects/${slug}.md`);
    expect(note).toContain("- [decision] Call the cart API with [redacted] — staging only");
    expect(note).not.toContain("sk-ant-fake");
  });
});
