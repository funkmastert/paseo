import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { KB_PROJECT_LABEL, PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  KnowledgeBaseSearchUnavailableError,
  KnowledgeBaseWriteConflictError,
} from "../session/knowledge-base/knowledge-base-session.js";
import { assignmentsFilePath } from "./assignments.js";
import {
  BASIC_MEMORY_DEDUPE_MIN_SCORE,
  BASIC_MEMORY_DEDUPE_SEARCH_TYPE,
  BasicMemorySearchError,
  type BasicMemorySearchInput,
  type BasicMemorySearchResult,
} from "./basic-memory-client.js";
import type { BasicMemorySidecarStatus } from "./basic-memory-sidecar.js";
import type { ResolvedKnowledgeBaseConfig } from "./config.js";
import { createProjectNote, parseNote, serializeNote } from "./note-format.js";
import { NoteStore, type NoteRecord } from "./note-store.js";
import {
  KnowledgeBaseNoProjectError,
  KnowledgeBaseService,
  KnowledgeProjectWriteRefusedError,
  type KnowledgeBaseAgent,
  type KnowledgeBaseAgents,
  type KnowledgeBaseWorkspace,
  type KnowledgeBaseWorkspaces,
} from "./service.js";
import { buildProjectSummary } from "./summary.js";

const NOW = new Date("2026-10-08T12:00:00.000Z");
const TODAY = "2026-10-08";
const FIGMA = "https://www.figma.com/design/fake123/Checkout?node-id=1-2";
const TICKET = "https://linear.app/fake-team/issue/FAKE-42/checkout";

class FakeAgents implements KnowledgeBaseAgents {
  readonly records = new Map<string, KnowledgeBaseAgent>();
  failGet = false;

  add(id: string, overrides: Partial<Omit<KnowledgeBaseAgent, "id">> = {}): void {
    this.records.set(id, {
      id,
      labels: {},
      title: `Agent ${id}`,
      provider: "mock",
      workspaceId: null,
      ...overrides,
    });
  }

  labelsOf(id: string): Record<string, string> {
    const record = this.records.get(id);
    if (!record) throw new Error(`no agent ${id}`);
    return record.labels;
  }

  async get(agentId: string): Promise<KnowledgeBaseAgent | null> {
    if (this.failGet) throw new Error("agent storage is unreadable");
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

class FakeWorkspaces implements KnowledgeBaseWorkspaces {
  readonly records = new Map<string, KnowledgeBaseWorkspace>();

  async get(workspaceId: string): Promise<KnowledgeBaseWorkspace | null> {
    return this.records.get(workspaceId) ?? null;
  }
}

class FakeSearch {
  readonly calls: BasicMemorySearchInput[] = [];
  results: BasicMemorySearchResult[] = [];
  error: BasicMemorySearchError | null = null;

  async search(input: BasicMemorySearchInput): Promise<BasicMemorySearchResult[]> {
    this.calls.push(input);
    if (this.error) throw this.error;
    return this.results;
  }
}

/** A real store that, on the first read of `conflictPath`, lets "Obsidian" rewrite the file. */
class ObsidianRacingNoteStore extends NoteStore {
  private raced = false;

  constructor(
    private readonly dir: string,
    private readonly conflictPath: string,
    private readonly externalContent: (current: string) => string,
  ) {
    super(dir);
  }

  override async read(relativePath: string): Promise<NoteRecord | null> {
    const record = await super.read(relativePath);
    if (record && relativePath === this.conflictPath && !this.raced) {
      this.raced = true;
      const absolute = path.join(this.dir, relativePath);
      await fs.writeFile(absolute, this.externalContent(record.content));
      const later = new Date(record.modifiedAt + 5_000);
      await fs.utimes(absolute, later, later);
    }
    return record;
  }
}

let notesDir: string;
let agents: FakeAgents;
let workspaces: FakeWorkspaces;
let search: FakeSearch;
let sidecarStatus: BasicMemorySidecarStatus;
let service: KnowledgeBaseService;

function enabledConfig(overrides: Partial<ResolvedKnowledgeBaseConfig> = {}) {
  return {
    enabled: true,
    notesDir,
    basicMemory: { command: "basic-memory", semanticSearch: true },
    ...overrides,
  };
}

async function startService(
  options: { createNoteStore?: (dir: string) => NoteStore } = {},
): Promise<KnowledgeBaseService> {
  const started = new KnowledgeBaseService({
    logger: createTestLogger(),
    agents,
    workspaces,
    search,
    sidecar: { getStatus: () => sidecarStatus },
    now: () => NOW,
    ...options,
  });
  await started.applyConfig(enabledConfig());
  return started;
}

async function readNote(relativePath: string): Promise<string> {
  return await fs.readFile(path.join(notesDir, relativePath), "utf8");
}

async function noteExists(relativePath: string): Promise<boolean> {
  return await fs
    .stat(path.join(notesDir, relativePath))
    .then(() => true)
    .catch(() => false);
}

async function projectFiles(): Promise<string[]> {
  const entries = await fs.readdir(path.join(notesDir, "projects")).catch(() => []);
  return entries.filter((name) => name.endsWith(".md")).sort();
}

async function seedProject(input: {
  title: string;
  summary?: string;
  links?: string[];
  decisions?: string[];
}): Promise<string> {
  const doc = createProjectNote({
    title: input.title,
    summary: input.summary ?? "",
    created: TODAY,
  });
  const sections = doc.sections.map((section) => {
    if (section.heading === "## Links") return { ...section, bodyLines: input.links ?? [] };
    if (section.heading === "## Decisions") return { ...section, bodyLines: input.decisions ?? [] };
    return section;
  });
  const content = serializeNote({ ...doc, sections });
  const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  await fs.mkdir(path.join(notesDir, "projects"), { recursive: true });
  await fs.writeFile(path.join(notesDir, "projects", `${slug}.md`), content);
  return slug;
}

function linksOf(content: string): string[] {
  const section = parseNote(content).sections.find((candidate) => candidate.heading === "## Links");
  return section ? section.bodyLines.filter((line) => line.startsWith("- [")) : [];
}

function searchHit(input: { slug: string; title: string; score: number }): BasicMemorySearchResult {
  return {
    permalink: null,
    filePath: `projects/${input.slug}.md`,
    title: input.title,
    score: input.score,
    snippet: "",
    noteType: "project",
  };
}

beforeEach(async () => {
  notesDir = await fs.mkdtemp(path.join(os.tmpdir(), "kb-service-"));
  agents = new FakeAgents();
  workspaces = new FakeWorkspaces();
  search = new FakeSearch();
  sidecarStatus = { state: "running", since: 0, pid: 4242, version: "0.23.2", stderrTail: [] };
  service = await startService();
});

afterEach(async () => {
  await fs.rm(notesDir, { recursive: true, force: true });
});

describe("filing links (AE2)", () => {
  test("a link filed for an untagged agent lands in the Inbox, and moves to the project the agent creates", async () => {
    agents.add("agent-a");

    expect(await service.fileLink({ agentId: "agent-a", url: FIGMA, category: "figma" })).toEqual({
      outcome: "filed",
      note: "inbox.md",
    });
    expect(linksOf(await readNote("inbox.md"))).toEqual([
      `- [figma] ${FIGMA} (agent agent-a, ${TODAY})`,
    ]);

    const result = await service.create({
      agentId: "agent-a",
      title: "Checkout redesign",
      summary: "Redesign the checkout flow.",
    });

    expect(result).toEqual({
      outcome: "created",
      project: {
        slug: "checkout-redesign",
        title: "Checkout redesign",
        path: "projects/checkout-redesign.md",
      },
      reason: "No existing project matched, so a new one was created.",
    });
    expect(linksOf(await readNote("projects/checkout-redesign.md"))).toEqual([
      `- [figma] ${FIGMA} (${TODAY})`,
    ]);
    expect(linksOf(await readNote("inbox.md"))).toEqual([]);
    expect(agents.labelsOf("agent-a")[KB_PROJECT_LABEL]).toBe("checkout-redesign");
  });

  test("a link filed for a tagged agent goes straight to that project", async () => {
    await seedProject({ title: "Checkout redesign" });
    agents.add("agent-a", { labels: { [KB_PROJECT_LABEL]: "checkout-redesign" } });

    expect(await service.fileLink({ agentId: "agent-a", url: FIGMA, category: "figma" })).toEqual({
      outcome: "filed",
      note: "projects/checkout-redesign.md",
    });
    expect(linksOf(await readNote("projects/checkout-redesign.md"))).toEqual([
      `- [figma] ${FIGMA} (${TODAY})`,
    ]);
    expect(await noteExists("inbox.md")).toBe(false);
  });

  test("a link already in the project is not filed twice", async () => {
    await seedProject({ title: "Checkout redesign", links: [`- [figma] ${FIGMA} (2026-10-01)`] });
    agents.add("agent-a", { labels: { [KB_PROJECT_LABEL]: "checkout-redesign" } });

    expect(await service.fileLink({ agentId: "agent-a", url: FIGMA, category: "figma" })).toEqual({
      outcome: "already_filed",
      note: "projects/checkout-redesign.md",
    });
    expect(linksOf(await readNote("projects/checkout-redesign.md"))).toEqual([
      `- [figma] ${FIGMA} (2026-10-01)`,
    ]);
  });

  test("a URL that still carries a token after scrubbing is not filed", async () => {
    agents.add("agent-a");
    const leaky = `https://github.example/repo#ghp_${"a".repeat(36)}`;

    expect(await service.fileLink({ agentId: "agent-a", url: leaky, category: "link" })).toEqual({
      outcome: "dropped_secret",
    });
    expect(await noteExists("inbox.md")).toBe(false);
  });

  test("a filing write that races an Obsidian edit re-reads and retries once, and both land", async () => {
    await seedProject({ title: "Checkout redesign", summary: "Redesign the checkout flow." });
    agents.add("agent-a", { labels: { [KB_PROJECT_LABEL]: "checkout-redesign" } });
    service = await startService({
      createNoteStore: (dir) =>
        new ObsidianRacingNoteStore(dir, "projects/checkout-redesign.md", (current) =>
          current.replace("Redesign the checkout flow.", "Redesign the checkout flow, edited."),
        ),
    });

    await service.fileLink({ agentId: "agent-a", url: FIGMA, category: "figma" });

    const content = await readNote("projects/checkout-redesign.md");
    expect(content).toContain("Redesign the checkout flow, edited.");
    expect(linksOf(content)).toEqual([`- [figma] ${FIGMA} (${TODAY})`]);
  });
});

describe("creating projects (AE3 and dedupe)", () => {
  test("covers AE3: two platform agents sharing a Figma link create concurrently and end up in one project", async () => {
    agents.add("agent-ios");
    agents.add("agent-android");
    await service.fileLink({ agentId: "agent-ios", url: FIGMA, category: "figma" });
    await service.fileLink({ agentId: "agent-android", url: FIGMA, category: "figma" });

    const [ios, android] = await Promise.all([
      service.create({
        agentId: "agent-ios",
        title: "Checkout redesign",
        summary: "Redesign the checkout flow on iOS.",
      }),
      service.create({
        agentId: "agent-android",
        title: "Checkout redesign (Android)",
        summary: "Redesign the checkout flow on Android.",
      }),
    ]);

    const project = {
      slug: "checkout-redesign",
      title: "Checkout redesign",
      path: "projects/checkout-redesign.md",
    };
    expect(ios).toEqual({
      outcome: "created",
      project,
      reason: "No existing project matched, so a new one was created.",
    });
    expect(android).toEqual({
      outcome: "joined",
      project,
      reason: "A Figma file, ticket or PR this session filed is already in this project.",
    });
    expect(await projectFiles()).toEqual(["checkout-redesign.md"]);
    expect(agents.labelsOf("agent-ios")[KB_PROJECT_LABEL]).toBe("checkout-redesign");
    expect(agents.labelsOf("agent-android")[KB_PROJECT_LABEL]).toBe("checkout-redesign");
    expect(linksOf(await readNote("projects/checkout-redesign.md"))).toEqual([
      `- [figma] ${FIGMA} (${TODAY})`,
    ]);
    expect(linksOf(await readNote("inbox.md"))).toEqual([]);
  });

  test("covers AE3: without a shared link, a title that normalizes to an existing project's returns it as a candidate", async () => {
    agents.add("agent-ios");
    agents.add("agent-android");
    await service.create({ agentId: "agent-ios", title: "Checkout redesign", summary: "" });

    const result = await service.create({
      agentId: "agent-android",
      title: "Checkout Redesign (Android)",
      summary: "",
    });

    expect(result).toEqual({
      outcome: "candidates",
      candidates: [
        {
          slug: "checkout-redesign",
          title: "Checkout redesign",
          path: "projects/checkout-redesign.md",
        },
      ],
      reason:
        "An existing project has the same name. Open it with kb_open, or repeat kb_create with confirmNew if this is different work.",
    });
    expect(await projectFiles()).toEqual(["checkout-redesign.md"]);
    expect(agents.labelsOf("agent-android")).toEqual({});
  });

  test("two siblings under one parent creating unrelated titles get two projects", async () => {
    agents.add("parent");
    agents.add("child-a", { labels: { [PARENT_AGENT_ID_LABEL]: "parent" } });
    agents.add("child-b", { labels: { [PARENT_AGENT_ID_LABEL]: "parent" } });
    await service.fileLink({ agentId: "child-a", url: FIGMA, category: "figma" });
    await service.fileLink({ agentId: "child-b", url: TICKET, category: "ticket" });

    const [a, b] = await Promise.all([
      service.create({ agentId: "child-a", title: "Checkout redesign", summary: "" }),
      service.create({ agentId: "child-b", title: "Search ranking", summary: "" }),
    ]);

    expect([a.outcome, b.outcome]).toEqual(["created", "created"]);
    expect(await projectFiles()).toEqual(["checkout-redesign.md", "search-ranking.md"]);
  });

  test("a Basic Memory match scoring exactly the dedupe floor returns candidates and creates nothing", async () => {
    await seedProject({ title: "Checkout redesign" });
    agents.add("agent-a");
    search.results = [
      searchHit({ slug: "checkout-redesign", title: "Checkout redesign", score: 0.7 }),
    ];

    const result = await service.create({
      agentId: "agent-a",
      title: "Payment page refresh",
      summary: "Refresh the payment page.",
    });

    expect(result).toEqual({
      outcome: "candidates",
      candidates: [
        {
          slug: "checkout-redesign",
          title: "Checkout redesign",
          path: "projects/checkout-redesign.md",
        },
      ],
      reason:
        "Existing projects look like the same work. Open one with kb_open, or repeat kb_create with confirmNew if this is different work.",
    });
    expect(search.calls).toEqual([
      {
        query: "Payment page refresh\nRefresh the payment page.",
        searchType: BASIC_MEMORY_DEDUPE_SEARCH_TYPE,
        noteTypes: ["project"],
        minSimilarity: BASIC_MEMORY_DEDUPE_MIN_SCORE,
        limit: 3,
      },
    ]);
    expect(await projectFiles()).toEqual(["checkout-redesign.md"]);
  });

  test("a Basic Memory match just under the floor creates the project", async () => {
    await seedProject({ title: "Checkout redesign" });
    agents.add("agent-a");
    search.results = [
      searchHit({ slug: "checkout-redesign", title: "Checkout redesign", score: 0.69 }),
    ];

    const result = await service.create({
      agentId: "agent-a",
      title: "Payment page refresh",
      summary: "Refresh the payment page.",
    });

    expect(result.outcome).toBe("created");
    expect(await projectFiles()).toEqual(["checkout-redesign.md", "payment-page-refresh.md"]);
  });

  test("confirmNew skips the title and search rules and creates", async () => {
    await seedProject({ title: "Checkout redesign" });
    agents.add("agent-a");
    search.results = [
      searchHit({ slug: "checkout-redesign", title: "Checkout redesign", score: 0.9 }),
    ];

    const result = await service.create({
      agentId: "agent-a",
      title: "Checkout redesign",
      summary: "",
      confirmNew: true,
    });

    expect(result).toEqual({
      outcome: "created",
      project: {
        slug: "checkout-redesign-2",
        title: "Checkout redesign",
        path: "projects/checkout-redesign-2.md",
      },
      reason: "No existing project matched, so a new one was created.",
    });
    expect(search.calls).toEqual([]);
  });

  test("with Basic Memory down, create still applies the title rule and otherwise creates", async () => {
    await seedProject({ title: "Checkout redesign" });
    agents.add("agent-a");
    search.error = new BasicMemorySearchError("search_unavailable", "Basic Memory is backoff");

    const sameTitle = await service.create({
      agentId: "agent-a",
      title: "Checkout redesign (iOS)",
      summary: "",
    });
    const different = await service.create({
      agentId: "agent-a",
      title: "Payment page refresh",
      summary: "",
    });

    expect(sameTitle.outcome).toBe("candidates");
    expect(different.outcome).toBe("created");
    expect(await projectFiles()).toEqual(["checkout-redesign.md", "payment-page-refresh.md"]);
  });

  test("a create appends one Sessions line for the creator and tags its worktree", async () => {
    workspaces.records.set("ws-worktree", { kind: "worktree", branch: "feat/checkout" });
    agents.add("agent-a", {
      title: "Checkout kickoff",
      provider: "codex",
      workspaceId: "ws-worktree",
    });

    await service.create({ agentId: "agent-a", title: "Checkout redesign", summary: "" });
    await service.join({ agentId: "agent-a", project: "checkout-redesign" });

    const sessions = parseNote(await readNote("projects/checkout-redesign.md")).sections.find(
      (section) => section.heading === "## Sessions",
    );
    expect(sessions?.bodyLines).toEqual([
      `- [session] Checkout kickoff (codex, feat/checkout) — agent agent-a (${TODAY})`,
    ]);
    expect(
      await service.resolveAtCreate({ agentId: "agent-b", labels: {}, workspaceId: "ws-worktree" }),
    ).toEqual({ [KB_PROJECT_LABEL]: "checkout-redesign" });
  });
});

describe("resolving an agent's project at create (KTD-7)", () => {
  test("a child of an agent with a project inherits it and gets a snapshot built from the note", async () => {
    const slug = await seedProject({
      title: "Checkout redesign",
      summary: "Redesign the checkout flow.",
      links: [`- [figma] ${FIGMA} (${TODAY})`],
      decisions: ["- [decision] Ship behind a flag (2026-10-07)"],
    });
    agents.add("parent", { labels: { [KB_PROJECT_LABEL]: slug } });

    const labels = await service.resolveAtCreate({
      agentId: "child",
      labels: { [PARENT_AGENT_ID_LABEL]: "parent" },
      workspaceId: null,
    });

    expect(labels).toEqual({ [KB_PROJECT_LABEL]: "checkout-redesign" });
    const note = parseNote(await readNote("projects/checkout-redesign.md"));
    expect(service.getSnapshot("child")).toEqual({
      project: "checkout-redesign",
      text: buildProjectSummary(note, "checkout-redesign"),
      takenAt: NOW.toISOString(),
    });
  });

  test("an agent created in a tagged worktree inherits its project; one in a local checkout does not", async () => {
    await seedProject({ title: "Checkout redesign" });
    workspaces.records.set("ws-worktree", { kind: "worktree", branch: "feat/checkout" });
    workspaces.records.set("ws-local", { kind: "local_checkout", branch: "main" });
    agents.add("joiner-worktree", { workspaceId: "ws-worktree" });
    agents.add("joiner-local", { workspaceId: "ws-local" });
    await service.join({ agentId: "joiner-worktree", project: "checkout-redesign" });
    await service.join({ agentId: "joiner-local", project: "checkout-redesign" });

    expect(
      await service.resolveAtCreate({ agentId: "new-1", labels: {}, workspaceId: "ws-worktree" }),
    ).toEqual({ [KB_PROJECT_LABEL]: "checkout-redesign" });
    expect(
      await service.resolveAtCreate({ agentId: "new-2", labels: {}, workspaceId: "ws-local" }),
    ).toEqual({});
    expect(service.getSnapshot("new-2")).toBeNull();
  });

  test("an imported successor arriving with the predecessor's label gets its own snapshot", async () => {
    await seedProject({ title: "Checkout redesign", summary: "Redesign the checkout flow." });

    const labels = await service.resolveAtCreate({
      agentId: "successor",
      labels: { [KB_PROJECT_LABEL]: "checkout-redesign", "paseo.handoff-from": "predecessor" },
      workspaceId: null,
    });

    expect(labels).toEqual({ [KB_PROJECT_LABEL]: "checkout-redesign" });
    expect(service.getSnapshot("successor")?.project).toBe("checkout-redesign");
  });

  test("a relaunch of the same agent keeps its first snapshot even after the note changes", async () => {
    await seedProject({ title: "Checkout redesign", summary: "Redesign the checkout flow." });
    const input = {
      agentId: "agent-a",
      labels: { [KB_PROJECT_LABEL]: "checkout-redesign" },
      workspaceId: null,
    };
    await service.resolveAtCreate(input);
    const first = service.getSnapshot("agent-a");
    const notePath = path.join(notesDir, "projects/checkout-redesign.md");
    const content = await fs.readFile(notePath, "utf8");
    await fs.writeFile(notePath, content.replace("Redesign the checkout flow.", "Changed."));

    await service.resolveAtCreate(input);

    expect(service.getSnapshot("agent-a")).toEqual(first);
  });

  test("a label naming a project with no note falls through to the parent", async () => {
    await seedProject({ title: "Checkout redesign" });
    agents.add("parent", { labels: { [KB_PROJECT_LABEL]: "checkout-redesign" } });

    expect(
      await service.resolveAtCreate({
        agentId: "child",
        labels: { [KB_PROJECT_LABEL]: "deleted-project", [PARENT_AGENT_ID_LABEL]: "parent" },
        workspaceId: null,
      }),
    ).toEqual({ [KB_PROJECT_LABEL]: "checkout-redesign" });
  });

  test("with no label, parent project or tagged workspace, the agent stays untagged", async () => {
    agents.add("parent");
    expect(
      await service.resolveAtCreate({
        agentId: "child",
        labels: { [PARENT_AGENT_ID_LABEL]: "parent" },
        workspaceId: null,
      }),
    ).toEqual({});
  });

  test("with the knowledge base off, nothing resolves and nothing is written", async () => {
    await seedProject({ title: "Checkout redesign" });
    await service.applyConfig(enabledConfig({ enabled: false }));

    expect(
      await service.resolveAtCreate({
        agentId: "agent-a",
        labels: { [KB_PROJECT_LABEL]: "checkout-redesign" },
        workspaceId: null,
      }),
    ).toEqual({});
    expect(await noteExists(".bozeo/assignments.json")).toBe(false);
  });
});

describe("recording into a project", () => {
  test("a decision with a fake token is stored redacted and reports one removal", async () => {
    agents.add("agent-a");
    await service.create({ agentId: "agent-a", title: "Checkout redesign", summary: "" });

    const result = await service.record({
      agentId: "agent-a",
      kind: "decision",
      text: `Staging uses sk-ant-${"a".repeat(20)} for now`,
    });

    expect(result).toEqual({ project: "checkout-redesign", removedSecretSpans: 1 });
    const decisions = parseNote(await readNote("projects/checkout-redesign.md")).sections.find(
      (section) => section.heading === "## Decisions",
    );
    expect(decisions?.bodyLines).toEqual([
      `- [decision] Staging uses [redacted] for now (${TODAY})`,
    ]);
  });

  test("an untagged agent recording without a project is told to open or create one", async () => {
    agents.add("agent-a");
    await expect(
      service.record({ agentId: "agent-a", kind: "decision", text: "Ship behind a flag" }),
    ).rejects.toThrow(KnowledgeBaseNoProjectError);
  });

  test("naming a project the agent never joined or created is refused and writes nothing", async () => {
    await seedProject({ title: "Search ranking" });
    agents.add("agent-a");
    await service.create({ agentId: "agent-a", title: "Checkout redesign", summary: "" });
    const before = await readNote("projects/search-ranking.md");

    await expect(
      service.record({
        agentId: "agent-a",
        kind: "rule",
        text: "Never ship on Fridays",
        project: "search-ranking",
      }),
    ).rejects.toThrow(KnowledgeProjectWriteRefusedError);
    expect(await readNote("projects/search-ranking.md")).toBe(before);
  });
});

describe("rename and merge", () => {
  test("rename updates the note, inbound links, agent labels and the workspace tag", async () => {
    await seedProject({ title: "Checkout redesign" });
    await fs.writeFile(
      path.join(notesDir, "scratch.md"),
      "---\ntitle: Scratch\n---\nSee [[Checkout redesign]] and [[checkout-redesign|the old one]].\n",
    );
    workspaces.records.set("ws-worktree", { kind: "worktree", branch: "feat/checkout" });
    agents.add("agent-a", { workspaceId: "ws-worktree" });
    await service.join({ agentId: "agent-a", project: "checkout-redesign" });

    const renamed = await service.rename({
      path: "projects/checkout-redesign.md",
      title: "Checkout revamp",
    });

    expect(renamed).toEqual({
      path: "projects/checkout-revamp.md",
      permalink: "projects/checkout-revamp",
      title: "Checkout revamp",
      noteType: "project",
      modifiedAt: expect.any(Number),
      linkCount: 0,
      decisionCount: 0,
    });
    expect(await projectFiles()).toEqual(["checkout-revamp.md"]);
    const note = await readNote("projects/checkout-revamp.md");
    expect(note).toContain("title: Checkout revamp\n");
    expect(note).toContain("permalink: projects/checkout-revamp\n");
    expect(note).toContain("aliases:\n  - Checkout redesign\n");
    expect(await readNote("scratch.md")).toBe(
      "---\ntitle: Scratch\n---\nSee [[Checkout revamp]] and [[checkout-revamp|the old one]].\n",
    );
    expect(agents.labelsOf("agent-a")[KB_PROJECT_LABEL]).toBe("checkout-revamp");
    expect(
      await service.resolveAtCreate({ agentId: "agent-b", labels: {}, workspaceId: "ws-worktree" }),
    ).toEqual({ [KB_PROJECT_LABEL]: "checkout-revamp" });
  });

  test("rename and merge answer null for a path that is not a project note", async () => {
    await seedProject({ title: "Checkout redesign" });

    expect(await service.rename({ path: "inbox.md", title: "Elsewhere" })).toBeNull();
    expect(await service.rename({ path: "projects/missing.md", title: "Elsewhere" })).toBeNull();
    expect(
      await service.merge({
        sourcePath: "projects/missing.md",
        targetPath: "projects/checkout-redesign.md",
        dryRun: false,
      }),
    ).toBeNull();
    expect(await projectFiles()).toEqual(["checkout-redesign.md"]);
  });

  test("a merge dry run reports what would move and writes nothing; the merge then moves it", async () => {
    await seedProject({
      title: "Checkout redesign",
      links: [`- [figma] ${FIGMA} (2026-10-01)`],
      decisions: ["- [decision] Ship behind a flag (2026-10-01)"],
    });
    await seedProject({
      title: "Checkout v3",
      links: [`- [figma] ${FIGMA} (2026-10-02)`, `- [ticket] ${TICKET} (2026-10-02)`],
      decisions: ["- [decision] Keep the old receipt (2026-10-02)"],
    });
    workspaces.records.set("ws-worktree", { kind: "worktree", branch: "feat/checkout-v3" });
    agents.add("agent-b", { workspaceId: "ws-worktree" });
    await service.join({ agentId: "agent-b", project: "checkout-v3" });
    const sourceBefore = await readNote("projects/checkout-v3.md");
    const input = {
      sourcePath: "projects/checkout-v3.md",
      targetPath: "projects/checkout-redesign.md",
    };
    const expected = {
      moved: { links: 1, decisions: 1, rules: 0, agents: 1, workspaces: 1 },
      target: {
        path: "projects/checkout-redesign.md",
        permalink: "projects/checkout-redesign",
        title: "Checkout redesign",
      },
    };

    expect(await service.merge({ ...input, dryRun: true })).toEqual(expected);
    expect(await readNote("projects/checkout-v3.md")).toBe(sourceBefore);
    expect(agents.labelsOf("agent-b")[KB_PROJECT_LABEL]).toBe("checkout-v3");

    expect(await service.merge({ ...input, dryRun: false })).toEqual(expected);
    expect(await projectFiles()).toEqual(["checkout-redesign.md"]);
    const note = parseNote(await readNote("projects/checkout-redesign.md"));
    expect(linksOf(await readNote("projects/checkout-redesign.md"))).toEqual([
      `- [figma] ${FIGMA} (2026-10-01)`,
      `- [ticket] ${TICKET} (2026-10-02)`,
    ]);
    expect(note.sections.find((s) => s.heading === "## Decisions")?.bodyLines).toEqual([
      "- [decision] Ship behind a flag (2026-10-01)",
      "- [decision] Keep the old receipt (2026-10-02) (from B)",
    ]);
    expect(agents.labelsOf("agent-b")[KB_PROJECT_LABEL]).toBe("checkout-redesign");
    expect(
      await service.resolveAtCreate({ agentId: "agent-c", labels: {}, workspaceId: "ws-worktree" }),
    ).toEqual({ [KB_PROJECT_LABEL]: "checkout-redesign" });
  });
});

describe("restart", () => {
  test("a new service on the same notes directory reloads snapshots and workspace tags", async () => {
    await seedProject({ title: "Checkout redesign", summary: "Redesign the checkout flow." });
    workspaces.records.set("ws-worktree", { kind: "worktree", branch: "feat/checkout" });
    agents.add("agent-a", { workspaceId: "ws-worktree" });
    await service.join({ agentId: "agent-a", project: "checkout-redesign" });
    await service.resolveAtCreate({
      agentId: "child",
      labels: { [KB_PROJECT_LABEL]: "checkout-redesign" },
      workspaceId: null,
    });
    const snapshot = service.getSnapshot("child");

    const restarted = await startService();

    expect(restarted.getSnapshot("child")).toEqual(snapshot);
    expect(
      await restarted.resolveAtCreate({ agentId: "new", labels: {}, workspaceId: "ws-worktree" }),
    ).toEqual({ [KB_PROJECT_LABEL]: "checkout-redesign" });
  });

  test("a corrupt assignments file is moved aside and agents keep their projects through labels", async () => {
    await seedProject({ title: "Checkout redesign" });
    const filePath = assignmentsFilePath(notesDir);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{ not json");

    const restarted = await startService();

    const aside = (await fs.readdir(path.dirname(filePath))).filter((name) =>
      name.startsWith("assignments.json.corrupt-"),
    );
    expect(aside).toHaveLength(1);
    expect(restarted.getSnapshot("agent-a")).toBeNull();
    expect(
      await restarted.resolveAtCreate({
        agentId: "agent-a",
        labels: { [KB_PROJECT_LABEL]: "checkout-redesign" },
        workspaceId: null,
      }),
    ).toEqual({ [KB_PROJECT_LABEL]: "checkout-redesign" });
  });
});

describe("recall", () => {
  test("searches projects plus the note types asked for, and maps results to notes by file path", async () => {
    search.results = [
      searchHit({ slug: "checkout-redesign", title: "Checkout redesign", score: 1.2 }),
      {
        permalink: null,
        filePath: "inbox.md",
        title: "Inbox",
        score: 0.4,
        snippet: "figma",
        noteType: "inbox",
      },
    ];

    const hits = await service.recall({ query: "checkout flag", noteTypes: ["inbox"] });

    expect(search.calls).toEqual([
      { query: "checkout flag", noteTypes: ["project", "inbox"], limit: 10 },
    ]);
    expect(hits).toEqual([
      {
        path: "projects/checkout-redesign.md",
        project: "checkout-redesign",
        title: "Checkout redesign",
        noteType: "project",
        score: 1.2,
        snippet: "",
      },
      {
        path: "inbox.md",
        project: null,
        title: "Inbox",
        noteType: "inbox",
        score: 0.4,
        snippet: "figma",
      },
    ]);
  });
});

describe("the kb.* backend", () => {
  test("status reports the feature, the sidecar and a setup hint only when something is wrong", async () => {
    expect(service.status()).toEqual({ enabled: true, sidecar: sidecarStatus, setupHint: null });

    sidecarStatus = { state: "missing", command: "basic-memory", hint: "Run paseo kb setup." };
    expect(service.status()).toEqual({
      enabled: true,
      sidecar: sidecarStatus,
      setupHint: "Run paseo kb setup.",
    });

    await service.applyConfig(enabledConfig({ enabled: false }));
    sidecarStatus = { state: "disabled" };
    expect(service.status()).toEqual({
      enabled: false,
      sidecar: { state: "disabled" },
      setupHint:
        "Add a knowledgeBase section to config.json and reload. See docs/knowledge-base.md.",
    });
  });

  test("list summarizes every note, with or without frontmatter", async () => {
    await seedProject({
      title: "Checkout redesign",
      links: [`- [figma] ${FIGMA} (2026-10-01)`],
      decisions: ["- [decision] Ship behind a flag (2026-10-01)"],
    });
    await fs.mkdir(path.join(notesDir, "scratch"), { recursive: true });
    await fs.writeFile(path.join(notesDir, "scratch", "ideas.md"), "Just [[Checkout redesign]].\n");

    const notes = await service.list();

    expect(notes).toEqual([
      {
        path: "projects/checkout-redesign.md",
        permalink: "projects/checkout-redesign",
        title: "Checkout redesign",
        noteType: "project",
        modifiedAt: expect.any(Number),
        linkCount: 1,
        decisionCount: 1,
      },
      {
        path: "scratch/ideas.md",
        permalink: "scratch/ideas",
        title: "ideas",
        noteType: "note",
        modifiedAt: expect.any(Number),
        linkCount: 0,
        decisionCount: 0,
      },
    ]);
  });

  test("get returns the note with its outgoing links and backlinks; a missing note is null", async () => {
    await seedProject({ title: "Checkout redesign" });
    await seedProject({ title: "Search ranking" });
    const projectPath = path.join(notesDir, "projects", "search-ranking.md");
    const searchRanking = await fs.readFile(projectPath, "utf8");
    await fs.writeFile(
      projectPath,
      searchRanking.replace("## Related\n", "## Related\n- [related] [[Checkout redesign]]\n"),
    );
    await fs.writeFile(path.join(notesDir, "ideas.md"), "See [[checkout-redesign|checkout]].\n");

    const note = await service.get("projects/checkout-redesign.md");

    expect(note).toEqual({
      path: "projects/checkout-redesign.md",
      permalink: "projects/checkout-redesign",
      title: "Checkout redesign",
      noteType: "project",
      content: await readNote("projects/checkout-redesign.md"),
      modifiedAt: expect.any(Number),
      outgoingLinks: [],
      backlinks: [
        { path: "ideas.md", title: "ideas" },
        { path: "projects/search-ranking.md", title: "Search ranking" },
      ],
    });
    expect((await service.get("projects/search-ranking.md"))?.outgoingLinks).toEqual([
      "Checkout redesign",
    ]);
    expect(await service.get("projects/missing.md")).toBeNull();
  });

  test("write scrubs, returns the text as written, and turns a stale modifiedAt into a conflict", async () => {
    await seedProject({ title: "Checkout redesign" });
    const before = (await service.get("projects/checkout-redesign.md"))!;
    const edited = before.content.replace(
      "## Rules\n",
      `## Rules\n- [rule] Staging uses sk-ant-${"a".repeat(20)}\n`,
    );

    const written = await service.write({
      path: "projects/checkout-redesign.md",
      content: edited,
      expectedModifiedAt: before.modifiedAt,
    });

    expect(written).toEqual({
      path: "projects/checkout-redesign.md",
      modifiedAt: expect.any(Number),
      removedSecretSpans: 1,
      content: edited.replace(`sk-ant-${"a".repeat(20)}`, "[redacted]"),
    });
    expect(await readNote("projects/checkout-redesign.md")).toBe(written.content);
    await expect(
      service.write({
        path: "projects/checkout-redesign.md",
        content: before.content,
        expectedModifiedAt: before.modifiedAt,
      }),
    ).rejects.toThrow(KnowledgeBaseWriteConflictError);
    expect(await readNote("projects/checkout-redesign.md")).toBe(written.content);
  });

  test("write without expectedModifiedAt overwrites, and refuses paths outside the notes", async () => {
    await service.write({ path: "ideas.md", content: "first\n" });
    await service.write({ path: "ideas.md", content: "second\n" });

    expect(await readNote("ideas.md")).toBe("second\n");
    await expect(service.write({ path: ".bozeo/assignments.md", content: "x" })).rejects.toThrow(
      "Not a note path",
    );
    await expect(service.write({ path: "ideas.txt", content: "x" })).rejects.toThrow(
      "Not a note path",
    );
  });

  test("search covers every note type and reports an unavailable sidecar as such", async () => {
    search.results = [
      {
        permalink: null,
        filePath: "scratch/ideas.md",
        title: "ideas",
        score: 0.9,
        snippet: "checkout",
        noteType: null,
      },
    ];

    expect(await service.search("checkout")).toEqual([
      {
        path: "scratch/ideas.md",
        permalink: "scratch/ideas",
        title: "ideas",
        noteType: "note",
        score: 0.9,
        snippet: "checkout",
      },
    ]);
    expect(search.calls).toEqual([{ query: "checkout", limit: 20 }]);

    search.error = new BasicMemorySearchError("search_unavailable", "Basic Memory is starting");
    await expect(service.search("checkout")).rejects.toThrow(KnowledgeBaseSearchUnavailableError);
  });

  test("graph has a node per note and an edge per wiki link that resolves to another note", async () => {
    await seedProject({ title: "Checkout redesign" });
    await fs.writeFile(
      path.join(notesDir, "ideas.md"),
      "[[Checkout redesign]] twice: [[checkout-redesign]], and [[Nowhere]].\n",
    );

    const graph = await service.graph();

    expect(graph).toEqual({
      nodes: [
        {
          path: "ideas.md",
          permalink: "ideas",
          title: "ideas",
          noteType: "note",
          linkCount: 0,
        },
        {
          path: "projects/checkout-redesign.md",
          permalink: "projects/checkout-redesign",
          title: "Checkout redesign",
          noteType: "project",
          linkCount: 0,
        },
      ],
      edges: [{ source: "ideas.md", target: "projects/checkout-redesign.md" }],
    });
  });
});
