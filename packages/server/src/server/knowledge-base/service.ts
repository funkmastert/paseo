import { KB_PROJECT_LABEL, PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { Logger } from "pino";

import {
  KnowledgeBaseSearchUnavailableError,
  KnowledgeBaseWriteConflictError,
  type KnowledgeBaseBackend,
  type KnowledgeBaseBackendGraph,
  type KnowledgeBaseBackendMergeCounts,
  type KnowledgeBaseBackendMergeResult,
  type KnowledgeBaseBackendNote,
  type KnowledgeBaseBackendNoteSummary,
  type KnowledgeBaseBackendSearchResult,
  type KnowledgeBaseBackendStatus,
  type KnowledgeBaseBackendWriteInput,
  type KnowledgeBaseBackendWriteResult,
} from "../session/knowledge-base/knowledge-base-session.js";
import type { PersistedWorkspaceKind } from "../workspace-registry-model.js";
import { AssignmentsStore, assignmentsFilePath, type AgentSnapshot } from "./assignments.js";
import {
  BASIC_MEMORY_DEDUPE_MIN_SCORE,
  BASIC_MEMORY_DEDUPE_SEARCH_TYPE,
  BasicMemorySearchError,
  type BasicMemoryClient,
} from "./basic-memory-client.js";
import type { BasicMemorySidecar, BasicMemorySidecarStatus } from "./basic-memory-sidecar.js";
import type { ResolvedKnowledgeBaseConfig } from "./config.js";
import {
  addObservation,
  extractWikiLinkTargets,
  findSection,
  getFrontmatterList,
  getFrontmatterScalar,
  mergeNotes,
  parseNote,
  parseObservationLine,
  projectNotePath,
  projectPermalink,
  renameNote,
  rewriteWikiLinks,
  serializeNote,
  setFrontmatterScalar,
  slugify,
  createProjectNote,
  type NoteDocument,
} from "./note-format.js";
import { NoteConflictError, NoteStore } from "./note-store.js";
import { scrubText, scrubUrl } from "./scrub.js";
import { buildProjectSummary, countObservations } from "./summary.js";
import { normalizeTitle, singleLine, yamlScalar } from "./text.js";

/**
 * The knowledge base's one service (docs/knowledge-base.md, KTD-2, KTD-7, KTD-15): which project
 * each agent and worktree belongs to, and every create, join, record, file, rename and merge.
 * Creates, renames and merges run under one lock; a note's read-modify-write runs in that note's
 * queue; one agent's filing and joining run in that agent's queue, so a link filed while the agent
 * joins cannot be left behind in the Inbox.
 */

const INBOX_PATH = "inbox.md";
const PROJECTS_DIR = "projects/";
const DEDUPE_CANDIDATE_LIMIT = 3;
const RECALL_LIMIT = 10;
const VIEW_SEARCH_LIMIT = 20;
const TITLE_MAX_CHARS = 120;
/** The links two sessions on one initiative share (dedupe rule 1). */
const STRONG_LINK_CATEGORIES: ReadonlySet<string> = new Set(["figma", "ticket", "pr"]);

const DISABLED_HINT =
  "Add a knowledgeBase section to config.json and reload. See docs/knowledge-base.md.";
const CREATED_REASON = "No existing project matched, so a new one was created.";
const SHARED_LINK_REASON =
  "A Figma file, ticket or PR this session filed is already in this project.";
const SAME_NAME_REASON =
  "An existing project has the same name. Open it with kb_open, or repeat kb_create with confirmNew if this is different work.";
const SIMILAR_REASON =
  "Existing projects look like the same work. Open one with kb_open, or repeat kb_create with confirmNew if this is different work.";

export interface KnowledgeBaseAgent {
  id: string;
  labels: Record<string, string>;
  title: string | null;
  provider: string;
  workspaceId: string | null;
}

/** Live and stored agents; `setLabels` patches a live agent or its stored record. */
export interface KnowledgeBaseAgents {
  get(agentId: string): Promise<KnowledgeBaseAgent | null>;
  list(): Promise<KnowledgeBaseAgent[]>;
  setLabels(agentId: string, labels: Record<string, string>): Promise<void>;
}

export interface KnowledgeBaseWorkspace {
  kind: PersistedWorkspaceKind;
  branch: string | null;
}

export interface KnowledgeBaseWorkspaces {
  get(workspaceId: string): Promise<KnowledgeBaseWorkspace | null>;
}

export interface KnowledgeProject {
  slug: string;
  title: string;
  path: string;
}

export interface KnowledgeProjectNote {
  project: KnowledgeProject;
  content: string;
  modifiedAt: number;
}

export type CreateProjectResult =
  | { outcome: "created"; project: KnowledgeProject; reason: string }
  | { outcome: "joined"; project: KnowledgeProject; reason: string }
  | { outcome: "candidates"; candidates: KnowledgeProject[]; reason: string };

export type FileLinkResult =
  | { outcome: "filed"; note: string }
  | { outcome: "already_filed"; note: string }
  | { outcome: "dropped_secret" };

export type KnowledgeRecordKind = "decision" | "rule" | "status" | "link";

export interface KnowledgeRecordResult {
  project: string;
  removedSecretSpans: number;
}

export interface KnowledgeSearchHit {
  path: string;
  /** The project's slug when the hit is a project note. */
  project: string | null;
  title: string;
  noteType: string | null;
  score: number;
  snippet: string;
}

export class KnowledgeBaseDisabledError extends Error {
  constructor() {
    super("The knowledge base is off. Set knowledgeBase.enabled in the daemon config.");
    this.name = "KnowledgeBaseDisabledError";
  }
}

export class KnowledgeBaseAgentNotFoundError extends Error {
  constructor(readonly agentId: string) {
    super(`Agent ${agentId} was not found`);
    this.name = "KnowledgeBaseAgentNotFoundError";
  }
}

export class KnowledgeProjectNotFoundError extends Error {
  constructor(readonly project: string) {
    super(`No knowledge-base project "${project}". Find it with kb_search.`);
    this.name = "KnowledgeProjectNotFoundError";
  }
}

export class KnowledgeNoteNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`The note ${path} is gone`);
    this.name = "KnowledgeNoteNotFoundError";
  }
}

export class KnowledgeProjectExistsError extends Error {
  constructor(readonly project: string) {
    super(`A knowledge-base project "${project}" already exists`);
    this.name = "KnowledgeProjectExistsError";
  }
}

export class KnowledgeBaseNoProjectError extends Error {
  constructor(readonly agentId: string) {
    super("This session has no project yet. Open one with kb_open or create one with kb_create.");
    this.name = "KnowledgeBaseNoProjectError";
  }
}

/** An agent may write only into projects it joined or created this session (prompt injection). */
export class KnowledgeProjectWriteRefusedError extends Error {
  constructor(readonly project: string) {
    super(
      `This session has not joined project "${project}". Open it with kb_open before recording into it.`,
    );
    this.name = "KnowledgeProjectWriteRefusedError";
  }
}

export class KnowledgeLinkDroppedError extends Error {
  constructor() {
    super("That link carries a credential, so it was not recorded.");
    this.name = "KnowledgeLinkDroppedError";
  }
}

export class InvalidKnowledgeRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidKnowledgeRequestError";
  }
}

export interface KnowledgeBaseServiceOptions {
  logger: Logger;
  agents: KnowledgeBaseAgents;
  workspaces: KnowledgeBaseWorkspaces;
  search: Pick<BasicMemoryClient, "search">;
  sidecar: Pick<BasicMemorySidecar, "getStatus">;
  now?: () => Date;
  createNoteStore?: (notesDir: string) => NoteStore;
}

interface ActiveKnowledgeBase {
  config: ResolvedKnowledgeBaseConfig;
  store: NoteStore;
  assignments: AssignmentsStore;
}

interface LoadedProject extends KnowledgeProject {
  doc: NoteDocument;
  aliases: string[];
}

interface DescribedNote {
  summary: KnowledgeBaseBackendNoteSummary;
  content: string;
  aliases: string[];
  /** Wiki-link targets, deduplicated, in order of first appearance. */
  outgoing: string[];
}

interface InboxEntry {
  category: string;
  url: string;
  agentId: string;
  date: string;
}

/**
 * Implements `KnowledgeBaseBackend`, the `kb.*` RPCs' surface (status, list, get, write, search,
 * graph, rename, merge), beside what agents and the create flow use.
 */
export class KnowledgeBaseService implements KnowledgeBaseBackend {
  private readonly logger: Logger;
  private readonly agents: KnowledgeBaseAgents;
  private readonly workspaces: KnowledgeBaseWorkspaces;
  private readonly searchClient: Pick<BasicMemoryClient, "search">;
  private readonly sidecar: Pick<BasicMemorySidecar, "getStatus">;
  private readonly now: () => Date;
  private readonly createNoteStore: (notesDir: string) => NoteStore;
  private active: ActiveKnowledgeBase | null = null;
  private configGeneration = 0;
  private readonly lockTails = new Map<string, Promise<void>>();
  private readonly noteTails = new Map<string, Promise<void>>();
  private readonly agentTails = new Map<string, Promise<void>>();
  /** Projects each agent joined or created since the daemon started: what it may write into. */
  private readonly writeSets = new Map<string, Set<string>>();
  /** Strong links (rule 1) each agent's session filed since the daemon started. */
  private readonly sessionLinks = new Map<string, Set<string>>();

  constructor(options: KnowledgeBaseServiceOptions) {
    this.logger = options.logger.child({ module: "knowledge-base" });
    this.agents = options.agents;
    this.workspaces = options.workspaces;
    this.searchClient = options.search;
    this.sidecar = options.sidecar;
    this.now = options.now ?? (() => new Date());
    this.createNoteStore = options.createNoteStore ?? ((notesDir) => new NoteStore(notesDir));
  }

  /** At startup and on every config reload. Off drops the store; a new notesDir reloads it. */
  async applyConfig(config: ResolvedKnowledgeBaseConfig): Promise<void> {
    const generation = ++this.configGeneration;
    if (!config.enabled) {
      this.active = null;
      return;
    }
    if (this.active && this.active.config.notesDir === config.notesDir) {
      this.active = { ...this.active, config };
      return;
    }
    const assignments = await AssignmentsStore.load({
      filePath: assignmentsFilePath(config.notesDir),
      logger: this.logger,
    });
    if (generation !== this.configGeneration) return;
    this.active = { config, store: this.createNoteStore(config.notesDir), assignments };
  }

  isEnabled(): boolean {
    return this.active !== null;
  }

  getSidecarStatus(): BasicMemorySidecarStatus {
    return this.sidecar.getStatus();
  }

  /** The session-start summary taken when the agent was created on a project, if it was. */
  getSnapshot(agentId: string): AgentSnapshot | null {
    return this.active?.assignments.getSnapshot(agentId) ?? null;
  }

  /**
   * KTD-7 at agent create, once labels are final: an explicit `paseo.kb-project` label, else the
   * parent agent's project, else the worktree's. Returns the label to add (empty when untagged)
   * and stores the summary snapshot, unless this agent id already has one (a relaunch from its
   * stored config), so the system prompt stays identical across launches.
   */
  async resolveAtCreate(input: {
    agentId: string;
    labels: Record<string, string>;
    workspaceId: string | null;
  }): Promise<Record<string, string>> {
    const active = this.active;
    if (!active) return {};
    const project = await this.resolveProject(active, input.labels, input.workspaceId);
    if (!project) return {};
    if (input.workspaceId) await this.tagWorktree(active, input.workspaceId, project.slug);
    if (!active.assignments.getSnapshot(input.agentId)) {
      await active.assignments.setSnapshot(input.agentId, {
        project: project.slug,
        text: buildProjectSummary(project.doc, project.slug),
        takenAt: this.now().toISOString(),
      });
    }
    return { [KB_PROJECT_LABEL]: project.slug };
  }

  /** Files one URL Tyler typed: into the agent's project, else into the Inbox tagged with the agent. */
  async fileLink(input: {
    agentId: string;
    url: string;
    category: string;
  }): Promise<FileLinkResult> {
    const active = this.requireActive();
    const url = scrubUrl(input.url);
    if (!url) return { outcome: "dropped_secret" };
    return await serialize(this.agentTails, input.agentId, async () => {
      if (STRONG_LINK_CATEGORIES.has(input.category)) {
        setFor(this.sessionLinks, input.agentId).add(url);
      }
      const agent = await this.agents.get(input.agentId);
      const slug = agent?.labels[KB_PROJECT_LABEL];
      const project = slug ? await this.loadProject(active, slug) : null;
      const date = this.today();
      if (project) {
        const written = await this.updateNote(active, project.path, (doc) =>
          addObservation(doc, "Links", {
            category: input.category,
            text: url,
            suffix: `(${date})`,
          }),
        );
        return { outcome: written ? "filed" : "already_filed", note: project.path };
      }
      await active.store.ensureInbox();
      const entry = { category: input.category, url, agentId: input.agentId, date };
      const written = await this.updateNote(active, INBOX_PATH, (doc) => addInboxEntry(doc, entry));
      return { outcome: written ? "filed" : "already_filed", note: INBOX_PATH };
    });
  }

  /** Creates a project, or joins or proposes an existing one (the plan's "Dedupe on kb_create"). */
  async create(input: {
    agentId: string;
    title: string;
    summary: string;
    confirmNew?: boolean;
  }): Promise<CreateProjectResult> {
    const active = this.requireActive();
    const title = singleLine(input.title).slice(0, TITLE_MAX_CHARS);
    if (title.length === 0) throw new InvalidKnowledgeRequestError("A project needs a title.");
    const summary = singleLine(input.summary);
    return await serialize(this.lockTails, "kb", () =>
      serialize(this.agentTails, input.agentId, async () => {
        const agent = await this.requireAgent(input.agentId);
        const projects = await this.loadProjects(active);

        const sharing = await this.projectsSharingSessionLinks(active, input.agentId, projects);
        if (sharing.length === 1) {
          const joined = await this.joinUnlocked(active, agent, sharing[0]);
          return { outcome: "joined", project: joined, reason: SHARED_LINK_REASON };
        }
        if (!input.confirmNew) {
          const sameName = projectsNamed(projects, title);
          if (sameName.length > 0) {
            return { outcome: "candidates", candidates: sameName, reason: SAME_NAME_REASON };
          }
          const similar = await this.similarProjects(active, { title, summary, projects });
          if (similar.length > 0) {
            return { outcome: "candidates", candidates: similar, reason: SIMILAR_REASON };
          }
        }
        const created = await this.writeNewProject(active, { title, summary, projects });
        const project = await this.joinUnlocked(active, agent, created);
        return { outcome: "created", project, reason: CREATED_REASON };
      }),
    );
  }

  /**
   * Puts the agent on `project` (a slug): its label, its session write set, an untagged worktree's
   * tag, a `## Sessions` line, and its Inbox links moved into the project.
   */
  async join(input: { agentId: string; project: string }): Promise<KnowledgeProject> {
    const active = this.requireActive();
    return await serialize(this.agentTails, input.agentId, async () => {
      const agent = await this.requireAgent(input.agentId);
      const project = await this.requireProject(active, input.project);
      return await this.joinUnlocked(active, agent, project);
    });
  }

  /**
   * Appends a decision, rule, status line or link to the agent's project, or to `project` when
   * the agent joined or created it this session. Text is scrubbed first; the result counts what
   * the scrub removed.
   */
  async record(input: {
    agentId: string;
    kind: KnowledgeRecordKind;
    text: string;
    project?: string;
  }): Promise<KnowledgeRecordResult> {
    const active = this.requireActive();
    const agent = await this.requireAgent(input.agentId);
    const labelled = agent.labels[KB_PROJECT_LABEL];
    const target = input.project ?? labelled;
    if (!target) throw new KnowledgeBaseNoProjectError(input.agentId);
    const mayWrite = target === labelled || this.writeSets.get(input.agentId)?.has(target) === true;
    if (!mayWrite) throw new KnowledgeProjectWriteRefusedError(target);
    const project = await this.requireProject(active, target);

    const { text, removed } = scrubText(singleLine(input.text));
    const observation = observationFor(input.kind, text, this.today());
    if (!observation) throw new KnowledgeLinkDroppedError();
    await this.updateNote(active, project.path, (doc) =>
      addObservation(doc, observation.section, observation.entry),
    );
    return { project: project.slug, removedSecretSpans: removed };
  }

  /**
   * Recall search for agents (the U4 smoke run): Basic Memory's default search type (hybrid while
   * semantic search is on) over project notes plus the other note types asked for. Results map to
   * notes by file path, since permalinks are off. Throws `BasicMemorySearchError`.
   */
  async recall(input: {
    query: string;
    noteTypes?: string[];
    limit?: number;
  }): Promise<KnowledgeSearchHit[]> {
    this.requireActive();
    const noteTypes = Array.from(new Set(["project", ...(input.noteTypes ?? [])]));
    const results = await this.searchClient.search({
      query: input.query,
      noteTypes,
      limit: input.limit ?? RECALL_LIMIT,
    });
    return results.map((result) => {
      const notePath = toForwardSlashes(result.filePath);
      return {
        path: notePath,
        project: projectSlugFromPath(notePath),
        title: result.title,
        noteType: result.noteType,
        score: result.score,
        snippet: result.snippet,
      };
    });
  }

  /** Every project note, by title. What `kb_search` lists when Basic Memory is down. */
  async listProjects(): Promise<KnowledgeProject[]> {
    const projects = await this.loadProjects(this.requireActive());
    return projects.map(toProject).sort((a, b) => a.title.localeCompare(b.title));
  }

  /** A project by slug, permalink, title or alias, compared case-insensitively. */
  async findProject(reference: string): Promise<KnowledgeProject | null> {
    const wanted = reference.trim().toLowerCase();
    const projects = await this.loadProjects(this.requireActive());
    const match = projects.find((project) => {
      const names = [
        project.slug,
        projectPermalink(project.slug),
        project.title,
        ...project.aliases,
      ];
      return names.some((name) => name.toLowerCase() === wanted);
    });
    return match ? toProject(match) : null;
  }

  async readProject(slug: string): Promise<KnowledgeProjectNote | null> {
    const active = this.requireActive();
    if (!isProjectSlug(slug)) return null;
    const record = await active.store.read(projectNotePath(slug));
    if (!record) return null;
    const project = toLoadedProject(slug, parseNote(record.content));
    return { project: toProject(project), content: record.content, modifiedAt: record.modifiedAt };
  }

  /** `kb.status`: whether the feature is on, the sidecar's state, and how to fix it if not. */
  status(): KnowledgeBaseBackendStatus {
    const sidecar = this.sidecar.getStatus();
    if (!this.active) return { enabled: false, sidecar, setupHint: DISABLED_HINT };
    return { enabled: true, sidecar, setupHint: sidecarSetupHint(sidecar) };
  }

  /** Every note in the notes directory, projects or not. */
  async list(): Promise<KnowledgeBaseBackendNoteSummary[]> {
    const notes = await this.readAllNotes(this.requireActive());
    return notes.map((note) => note.summary);
  }

  /** One note with its outgoing wiki links and the notes that link to it. */
  async get(notePath: string): Promise<KnowledgeBaseBackendNote | null> {
    const notes = await this.readAllNotes(this.requireActive());
    const note = notes.find((candidate) => candidate.summary.path === notePath);
    if (!note) return null;
    const resolve = wikiLinkResolver(notes);
    const backlinks = notes
      .filter((other) => other !== note)
      .filter((other) => other.outgoing.some((target) => resolve(target) === note.summary.path))
      .map((other) => ({ path: other.summary.path, title: other.summary.title }));
    return {
      path: note.summary.path,
      permalink: note.summary.permalink,
      title: note.summary.title,
      noteType: note.summary.noteType,
      content: note.content,
      modifiedAt: note.summary.modifiedAt,
      outgoingLinks: note.outgoing,
      backlinks,
    };
  }

  /**
   * Tyler's whole-file edit from the view. Scrubbed by the store; `expectedModifiedAt` as in
   * `NoteStore.write`. Returns the text as written, which the editor adopts as its saved state.
   */
  async write(input: KnowledgeBaseBackendWriteInput): Promise<KnowledgeBaseBackendWriteResult> {
    const active = this.requireActive();
    if (!isWritableNotePath(input.path)) {
      throw new InvalidKnowledgeRequestError(`Not a note path: ${input.path}`);
    }
    const options =
      input.expectedModifiedAt === undefined
        ? undefined
        : { expectedModifiedAt: input.expectedModifiedAt };
    try {
      const written = await serialize(this.noteTails, input.path, () =>
        active.store.write(input.path, input.content, options),
      );
      return {
        path: input.path,
        modifiedAt: written.modifiedAt,
        removedSecretSpans: written.removedSecretSpans,
        content: scrubText(input.content).text,
      };
    } catch (error) {
      if (error instanceof NoteConflictError) throw new KnowledgeBaseWriteConflictError(input.path);
      throw error;
    }
  }

  /** The view's search: every note type, Basic Memory's default search type. */
  async search(query: string): Promise<KnowledgeBaseBackendSearchResult[]> {
    this.requireActive();
    let results;
    try {
      results = await this.searchClient.search({ query, limit: VIEW_SEARCH_LIMIT });
    } catch (error) {
      if (error instanceof BasicMemorySearchError && error.code === "search_unavailable") {
        throw new KnowledgeBaseSearchUnavailableError(error.message);
      }
      throw error;
    }
    return results.map((result) => {
      const notePath = toForwardSlashes(result.filePath);
      return {
        path: notePath,
        permalink: result.permalink ?? notePath.slice(0, -".md".length),
        title: result.title,
        noteType: result.noteType ?? "note",
        score: result.score,
        snippet: result.snippet,
      };
    });
  }

  /** Every note, and an edge for each wiki link that resolves to another note (KTD-2). */
  async graph(): Promise<KnowledgeBaseBackendGraph> {
    const notes = await this.readAllNotes(this.requireActive());
    const resolve = wikiLinkResolver(notes);
    const edges = new Map<string, { source: string; target: string }>();
    for (const note of notes) {
      for (const target of note.outgoing) {
        const targetPath = resolve(target);
        if (!targetPath || targetPath === note.summary.path) continue;
        edges.set(`${note.summary.path}\n${targetPath}`, {
          source: note.summary.path,
          target: targetPath,
        });
      }
    }
    const nodes = notes.map(({ summary }) => ({
      path: summary.path,
      permalink: summary.permalink,
      title: summary.title,
      noteType: summary.noteType,
      linkCount: summary.linkCount,
    }));
    return { nodes, edges: Array.from(edges.values()) };
  }

  /**
   * Renames the project note at `path`: its title and file, the old title kept as an alias, wiki
   * links in other notes, and agent labels, workspace tags and snapshots that named the old slug.
   * Null when `path` is not a project note.
   */
  async rename(input: {
    path: string;
    title: string;
  }): Promise<KnowledgeBaseBackendNoteSummary | null> {
    const active = this.requireActive();
    const title = singleLine(input.title).slice(0, TITLE_MAX_CHARS);
    if (title.length === 0) throw new InvalidKnowledgeRequestError("A project needs a title.");
    const currentSlug = projectSlugFromPath(input.path);
    if (!currentSlug) return null;
    return await serialize(this.lockTails, "kb", async () => {
      const project = await this.loadProject(active, currentSlug);
      if (!project) return null;
      const slug = slugify(title);
      const notePath = projectNotePath(slug);
      if (slug !== project.slug && (await active.store.read(notePath))) {
        throw new KnowledgeProjectExistsError(slug);
      }
      await this.updateNote(active, project.path, (doc) => renameNote(doc, yamlScalar(title)));
      if (slug !== project.slug) await active.store.move(project.path, notePath);
      await this.repointProject(active, { from: project, to: { slug, title, path: notePath } });
      const record = await active.store.read(notePath);
      if (!record) throw new KnowledgeNoteNotFoundError(notePath);
      return describeNote(notePath, record.content, record.modifiedAt).summary;
    });
  }

  /**
   * Folds the project at `sourcePath` into the one at `targetPath` (note-format `mergeNotes`),
   * removes the source and repoints everything that named it. `dryRun` writes nothing and reports
   * what would move. Null when either path is not a project note.
   */
  async merge(input: {
    sourcePath: string;
    targetPath: string;
    dryRun: boolean;
  }): Promise<KnowledgeBaseBackendMergeResult | null> {
    const active = this.requireActive();
    if (input.sourcePath === input.targetPath) {
      throw new InvalidKnowledgeRequestError("A project cannot be merged into itself.");
    }
    const sourceSlug = projectSlugFromPath(input.sourcePath);
    const targetSlug = projectSlugFromPath(input.targetPath);
    if (!sourceSlug || !targetSlug) return null;
    return await serialize(this.lockTails, "kb", async () => {
      const source = await this.loadProject(active, sourceSlug);
      const target = await this.loadProject(active, targetSlug);
      if (!source || !target) return null;
      const moved = await this.mergeCounts(active, { source, target });
      if (!input.dryRun) {
        await this.updateNote(active, target.path, (doc) => mergeNotes(doc, source.doc));
        await active.store.delete(source.path);
        await this.repointProject(active, { from: source, to: toProject(target) });
      }
      const permalink =
        getFrontmatterScalar(target.doc, "permalink") ?? projectPermalink(target.slug);
      return { moved, target: { path: target.path, permalink, title: target.title } };
    });
  }

  private requireActive(): ActiveKnowledgeBase {
    if (!this.active) throw new KnowledgeBaseDisabledError();
    return this.active;
  }

  private async requireAgent(agentId: string): Promise<KnowledgeBaseAgent> {
    const agent = await this.agents.get(agentId);
    if (!agent) throw new KnowledgeBaseAgentNotFoundError(agentId);
    return agent;
  }

  private async requireProject(active: ActiveKnowledgeBase, slug: string): Promise<LoadedProject> {
    const project = await this.loadProject(active, slug);
    if (!project) throw new KnowledgeProjectNotFoundError(slug);
    return project;
  }

  private async resolveProject(
    active: ActiveKnowledgeBase,
    labels: Record<string, string>,
    workspaceId: string | null,
  ): Promise<LoadedProject | null> {
    const explicit = labels[KB_PROJECT_LABEL];
    if (explicit) {
      const project = await this.loadProject(active, explicit);
      if (project) return project;
      this.logger.info({ project: explicit }, "A create's kb-project label names no project note");
    }
    const parentId = labels[PARENT_AGENT_ID_LABEL];
    const parentSlug = parentId
      ? (await this.agents.get(parentId))?.labels[KB_PROJECT_LABEL]
      : null;
    if (parentSlug) {
      const project = await this.loadProject(active, parentSlug);
      if (project) return project;
    }
    const workspaceSlug = workspaceId ? active.assignments.getWorkspaceProject(workspaceId) : null;
    if (workspaceSlug) return await this.loadProject(active, workspaceSlug);
    return null;
  }

  private async joinUnlocked(
    active: ActiveKnowledgeBase,
    agent: KnowledgeBaseAgent,
    project: LoadedProject,
  ): Promise<KnowledgeProject> {
    if (agent.labels[KB_PROJECT_LABEL] !== project.slug) {
      await this.agents.setLabels(agent.id, { [KB_PROJECT_LABEL]: project.slug });
    }
    setFor(this.writeSets, agent.id).add(project.slug);
    const workspace = agent.workspaceId ? await this.workspaces.get(agent.workspaceId) : null;
    if (agent.workspaceId) await this.tagWorktree(active, agent.workspaceId, project.slug);

    // The project gets the agent's Inbox links before the Inbox loses them, so a crash between
    // the two writes leaves a duplicate, never a lost link.
    const moving = await this.inboxEntriesFor(active, agent.id);
    const sessionLine = sessionObservation(agent, workspace, this.today());
    await this.updateNote(active, project.path, (doc) => {
      const withLinks = moving.reduce(
        (next, entry) =>
          addObservation(next, "Links", {
            category: entry.category,
            text: entry.url,
            suffix: `(${entry.date})`,
          }),
        doc,
      );
      return hasSessionLine(withLinks, agent.id)
        ? withLinks
        : addObservation(withLinks, "Sessions", sessionLine);
    });
    if (moving.length > 0) {
      await this.updateNote(active, INBOX_PATH, (doc) => removeInboxEntries(doc, agent.id));
    }
    return toProject(project);
  }

  /** Tags a worktree workspace with no project yet. Checkouts and directories host many. */
  private async tagWorktree(
    active: ActiveKnowledgeBase,
    workspaceId: string,
    slug: string,
  ): Promise<void> {
    if (active.assignments.getWorkspaceProject(workspaceId)) return;
    const workspace = await this.workspaces.get(workspaceId);
    if (workspace?.kind !== "worktree") return;
    await active.assignments.tagWorkspace(workspaceId, {
      project: slug,
      taggedAt: this.now().toISOString(),
    });
  }

  /**
   * Dedupe rule 1: the projects holding a Figma file, ticket or PR this agent's session filed,
   * whether it went to a project or still waits in the Inbox under the agent's id.
   */
  private async projectsSharingSessionLinks(
    active: ActiveKnowledgeBase,
    agentId: string,
    projects: LoadedProject[],
  ): Promise<LoadedProject[]> {
    const urls = new Set(this.sessionLinks.get(agentId));
    for (const entry of await this.inboxEntriesFor(active, agentId)) {
      if (STRONG_LINK_CATEGORIES.has(entry.category)) urls.add(entry.url);
    }
    if (urls.size === 0) return [];
    return projects.filter((project) => linkUrls(project.doc).some((url) => urls.has(url)));
  }

  private async inboxEntriesFor(
    active: ActiveKnowledgeBase,
    agentId: string,
  ): Promise<InboxEntry[]> {
    const inbox = await active.store.read(INBOX_PATH);
    if (!inbox) return [];
    return inboxEntries(parseNote(inbox.content)).filter((entry) => entry.agentId === agentId);
  }

  /** Dedupe rule 3: Basic Memory's vector search on the title and summary, at the floor or above. */
  private async similarProjects(
    active: ActiveKnowledgeBase,
    input: { title: string; summary: string; projects: LoadedProject[] },
  ): Promise<KnowledgeProject[]> {
    if (!active.config.basicMemory.semanticSearch) return [];
    const query = input.summary.length > 0 ? `${input.title}\n${input.summary}` : input.title;
    let results;
    try {
      results = await this.searchClient.search({
        query,
        searchType: BASIC_MEMORY_DEDUPE_SEARCH_TYPE,
        noteTypes: ["project"],
        minSimilarity: BASIC_MEMORY_DEDUPE_MIN_SCORE,
        limit: DEDUPE_CANDIDATE_LIMIT,
      });
    } catch (error) {
      if (!(error instanceof BasicMemorySearchError)) throw error;
      this.logger.info(
        { code: error.code },
        "Basic Memory search is unavailable; kb_create skips the similarity check",
      );
      return [];
    }
    const byPath = new Map(input.projects.map((project) => [project.path, project]));
    const matches = results
      .filter((result) => result.score >= BASIC_MEMORY_DEDUPE_MIN_SCORE)
      .map((result) => byPath.get(toForwardSlashes(result.filePath)))
      .filter((project): project is LoadedProject => project !== undefined);
    return Array.from(new Set(matches)).slice(0, DEDUPE_CANDIDATE_LIMIT).map(toProject);
  }

  private async writeNewProject(
    active: ActiveKnowledgeBase,
    input: { title: string; summary: string; projects: LoadedProject[] },
  ): Promise<LoadedProject> {
    const baseSlug = slugify(input.title);
    const taken = new Set(input.projects.map((project) => project.slug));
    for (let attempt = 1; ; attempt += 1) {
      const slug = attempt === 1 ? baseSlug : `${baseSlug}-${attempt}`;
      if (taken.has(slug)) continue;
      const created = createProjectNote({
        title: input.title,
        summary: input.summary,
        created: this.today(),
      });
      const doc = setFrontmatterScalar(
        setFrontmatterScalar(created, "title", yamlScalar(input.title)),
        "permalink",
        projectPermalink(slug),
      );
      try {
        await active.store.write(projectNotePath(slug), serializeNote(doc), {
          expectedModifiedAt: null,
        });
      } catch (error) {
        // A file Obsidian created that does not parse as a project is still taken.
        if (error instanceof NoteConflictError) continue;
        throw error;
      }
      return toLoadedProject(slug, doc);
    }
  }

  /** After a rename or merge: wiki links in other notes, agent labels, tags and write sets. */
  private async repointProject(
    active: ActiveKnowledgeBase,
    input: { from: KnowledgeProject; to: KnowledgeProject },
  ): Promise<void> {
    const { from, to } = input;
    const rewrites: Array<[string, string]> = [
      [from.title, to.title],
      [from.slug, to.slug],
      [projectPermalink(from.slug), projectPermalink(to.slug)],
    ];
    const notePaths = await active.store.list();
    for (const notePath of notePaths) {
      if (notePath === to.path) continue;
      await this.updateNoteText(active, notePath, (content) =>
        rewrites.reduce(
          (text, [oldTarget, newTarget]) =>
            oldTarget === newTarget ? text : rewriteWikiLinks(text, oldTarget, newTarget),
          content,
        ),
      );
    }
    if (from.slug === to.slug) return;

    for (const agent of await this.agents.list()) {
      if (agent.labels[KB_PROJECT_LABEL] !== from.slug) continue;
      try {
        await this.agents.setLabels(agent.id, { [KB_PROJECT_LABEL]: to.slug });
      } catch (error) {
        this.logger.warn({ err: error, agentId: agent.id }, "Could not relabel an agent's project");
      }
    }
    await active.assignments.retargetProject({ from: from.slug, to: to.slug });
    for (const projects of this.writeSets.values()) {
      if (projects.delete(from.slug)) projects.add(to.slug);
    }
  }

  private async readAllNotes(active: ActiveKnowledgeBase): Promise<DescribedNote[]> {
    const notes: DescribedNote[] = [];
    for (const notePath of await active.store.list()) {
      const record = await active.store.read(notePath);
      if (record) notes.push(describeNote(notePath, record.content, record.modifiedAt));
    }
    return notes;
  }

  /** What a merge of `source` into `target` moves; read before anything is written. */
  private async mergeCounts(
    active: ActiveKnowledgeBase,
    input: { source: LoadedProject; target: LoadedProject },
  ): Promise<KnowledgeBaseBackendMergeCounts> {
    const targetUrls = new Set(linkUrls(input.target.doc));
    const newUrls = new Set(linkUrls(input.source.doc).filter((url) => !targetUrls.has(url)));
    const agents = await this.agents.list();
    return {
      links: newUrls.size,
      decisions: countObservations(input.source.doc, "Decisions"),
      rules: countObservations(input.source.doc, "Rules"),
      agents: agents.filter((agent) => agent.labels[KB_PROJECT_LABEL] === input.source.slug).length,
      workspaces: active.assignments.workspacesTaggedWith(input.source.slug).length,
    };
  }

  private async loadProjects(active: ActiveKnowledgeBase): Promise<LoadedProject[]> {
    const projects: LoadedProject[] = [];
    for (const notePath of await active.store.list()) {
      const slug = projectSlugFromPath(notePath);
      const project = slug ? await this.loadProject(active, slug) : null;
      if (project) projects.push(project);
    }
    return projects;
  }

  /** The project note at `projects/<slug>.md`, or null if absent or not a parseable note. */
  private async loadProject(
    active: ActiveKnowledgeBase,
    slug: string,
  ): Promise<LoadedProject | null> {
    if (!isProjectSlug(slug)) return null;
    const record = await active.store.read(projectNotePath(slug));
    if (!record) return null;
    let doc: NoteDocument;
    try {
      doc = parseNote(record.content);
    } catch (error) {
      this.logger.info({ err: error, slug }, "Skipping a project note without frontmatter");
      return null;
    }
    return toLoadedProject(slug, doc);
  }

  /** Read-modify-write of one note in its queue. A concurrent outside edit is re-read once. */
  private async updateNote(
    active: ActiveKnowledgeBase,
    notePath: string,
    mutate: (doc: NoteDocument) => NoteDocument,
  ): Promise<boolean> {
    return await this.updateNoteText(active, notePath, (content) => {
      const doc = parseNote(content);
      const next = mutate(doc);
      return next === doc ? content : serializeNote(next);
    });
  }

  private async updateNoteText(
    active: ActiveKnowledgeBase,
    notePath: string,
    mutate: (content: string) => string,
  ): Promise<boolean> {
    return await serialize(this.noteTails, notePath, async () => {
      for (let attempt = 1; ; attempt += 1) {
        const record = await active.store.read(notePath);
        if (!record) throw new KnowledgeNoteNotFoundError(notePath);
        const next = mutate(record.content);
        if (next === record.content) return false;
        try {
          await active.store.write(notePath, next, { expectedModifiedAt: record.modifiedAt });
          return true;
        } catch (error) {
          if (!(error instanceof NoteConflictError) || attempt > 1) throw error;
          this.logger.info({ notePath }, "A note changed on disk during a write; retrying once");
        }
      }
    });
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }
}

/** Runs `fn` after everything already queued under `key`; the queue entry clears when idle. */
async function serialize<T>(
  tails: Map<string, Promise<void>>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  try {
    return await run;
  } finally {
    if (tails.get(key) === tail) tails.delete(key);
  }
}

function setFor(map: Map<string, Set<string>>, key: string): Set<string> {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

function toProject(project: KnowledgeProject): KnowledgeProject {
  return { slug: project.slug, title: project.title, path: project.path };
}

function toLoadedProject(slug: string, doc: NoteDocument): LoadedProject {
  return {
    slug,
    title: getFrontmatterScalar(doc, "title") ?? slug,
    path: projectNotePath(slug),
    doc,
    aliases: getFrontmatterList(doc, "aliases"),
  };
}

/** `projects/<slug>.md` directly under `projects/`, else null. */
function projectSlugFromPath(notePath: string): string | null {
  if (!notePath.startsWith(PROJECTS_DIR) || !notePath.endsWith(".md")) return null;
  const slug = notePath.slice(PROJECTS_DIR.length, -".md".length);
  return isProjectSlug(slug) ? slug : null;
}

/** A file name the store can hold under `projects/`: no separators, no dot-file, no `..`. */
function isProjectSlug(slug: string): boolean {
  return (
    slug.length > 0 &&
    !slug.startsWith(".") &&
    !slug.includes("/") &&
    !slug.includes("\\") &&
    !slug.includes("..")
  );
}

/** A `.md` path with no empty or dot-prefixed segment, so `.bozeo/` stays out of reach. */
function isWritableNotePath(notePath: string): boolean {
  if (!notePath.endsWith(".md")) return false;
  return notePath.split("/").every((segment) => segment.length > 0 && !segment.startsWith("."));
}

function sidecarSetupHint(status: BasicMemorySidecarStatus): string | null {
  if (status.state === "missing") return status.hint;
  if (status.state === "backoff") {
    return `Basic Memory is not running (${status.error}). Search is unavailable until it restarts.`;
  }
  return null;
}

/** Summary, aliases and outgoing wiki links of any note; one without frontmatter is a plain note. */
function describeNote(notePath: string, content: string, modifiedAt: number): DescribedNote {
  const stem = notePath.slice(0, -".md".length);
  const doc = parseNoteOrNull(content);
  const summary: KnowledgeBaseBackendNoteSummary = {
    path: notePath,
    permalink: (doc && getFrontmatterScalar(doc, "permalink")) ?? stem,
    title: (doc && getFrontmatterScalar(doc, "title")) ?? stem.slice(stem.lastIndexOf("/") + 1),
    noteType: (doc && getFrontmatterScalar(doc, "type")) ?? "note",
    modifiedAt,
    linkCount: doc ? countObservations(doc, "Links") : 0,
    decisionCount: doc ? countObservations(doc, "Decisions") : 0,
  };
  const outgoing = Array.from(new Set(extractWikiLinkTargets(content))).filter(
    (target) => target.length > 0,
  );
  return { summary, content, aliases: doc ? getFrontmatterList(doc, "aliases") : [], outgoing };
}

function parseNoteOrNull(content: string): NoteDocument | null {
  try {
    return parseNote(content);
  } catch {
    // Obsidian notes need no frontmatter; such a note is still a note.
    return null;
  }
}

/**
 * Maps a wiki-link target to a note path the way Obsidian and Basic Memory read one: by title,
 * alias, permalink or file name, case-insensitively. The first note to claim a name keeps it.
 */
function wikiLinkResolver(notes: DescribedNote[]): (target: string) => string | null {
  const byName = new Map<string, string>();
  for (const note of notes) {
    const stem = note.summary.path.slice(0, -".md".length);
    const names = [
      note.summary.title,
      ...note.aliases,
      note.summary.permalink,
      stem,
      stem.slice(stem.lastIndexOf("/") + 1),
    ];
    for (const name of names) {
      const key = name.toLowerCase();
      if (!byName.has(key)) byName.set(key, note.summary.path);
    }
  }
  return (target) => byName.get(target.trim().toLowerCase()) ?? null;
}

function toForwardSlashes(notePath: string): string {
  return notePath.split("\\").join("/");
}

function projectsNamed(projects: LoadedProject[], title: string): KnowledgeProject[] {
  const wanted = normalizeTitle(title);
  if (wanted.length === 0) return [];
  return projects
    .filter((project) =>
      [project.title, ...project.aliases].some((name) => normalizeTitle(name) === wanted),
    )
    .slice(0, DEDUPE_CANDIDATE_LIMIT)
    .map(toProject);
}

interface PendingObservation {
  section: string;
  entry: { category: string; text: string; suffix: string };
}

const RECORD_SECTIONS: Record<KnowledgeRecordKind, string> = {
  decision: "Decisions",
  rule: "Rules",
  status: "Status",
  link: "Links",
};

/** The observation a `record` writes, or null for a link that carries a credential. */
function observationFor(
  kind: KnowledgeRecordKind,
  text: string,
  date: string,
): PendingObservation | null {
  const section = RECORD_SECTIONS[kind];
  const suffix = `(${date})`;
  if (kind !== "link") return { section, entry: { category: kind, text, suffix } };
  const url = scrubUrl(text);
  return url ? { section, entry: { category: "link", text: url, suffix } } : null;
}

function sessionObservation(
  agent: KnowledgeBaseAgent,
  workspace: KnowledgeBaseWorkspace | null,
  date: string,
) {
  const where = workspace?.branch ? `${agent.provider}, ${workspace.branch}` : agent.provider;
  const title = singleLine(agent.title ?? "") || "Untitled agent";
  return {
    category: "session",
    text: `${title} (${where}) — agent ${agent.id}`,
    suffix: `(${date})`,
  };
}

function hasSessionLine(doc: NoteDocument, agentId: string): boolean {
  const marker = `— agent ${agentId} (`;
  return findSection(doc, "Sessions")?.bodyLines.some((line) => line.includes(marker)) === true;
}

/**
 * An Inbox entry: `- [figma] <url> (agent <agentId>, <date>)`. The agent id is in the line so
 * that agent's links move with it when it joins a project.
 */
function addInboxEntry(doc: NoteDocument, entry: InboxEntry): NoteDocument {
  const duplicate = inboxEntries(doc).some(
    (existing) => existing.url === entry.url && existing.agentId === entry.agentId,
  );
  if (duplicate) return doc;
  return addObservation(doc, "Links", {
    category: entry.category,
    text: entry.url,
    suffix: `(agent ${entry.agentId}, ${entry.date})`,
  });
}

function removeInboxEntries(doc: NoteDocument, agentId: string): NoteDocument {
  const sections = doc.sections.map((section) => ({
    ...section,
    bodyLines: section.bodyLines.filter((line) => parseInboxEntry(line)?.agentId !== agentId),
  }));
  return { ...doc, sections };
}

/** The URLs under a project's `## Links`. */
function linkUrls(doc: NoteDocument): string[] {
  const section = findSection(doc, "Links");
  if (!section) return [];
  return section.bodyLines.flatMap((line) => {
    const observation = parseObservationLine(line);
    return observation ? [observation.text] : [];
  });
}

function inboxEntries(doc: NoteDocument): InboxEntry[] {
  return doc.sections.flatMap((section) =>
    section.bodyLines.map(parseInboxEntry).filter((entry): entry is InboxEntry => entry !== null),
  );
}

function parseInboxEntry(line: string): InboxEntry | null {
  const observation = parseObservationLine(line);
  if (!observation) return null;
  const rest = observation.suffix ? `${observation.text} ${observation.suffix}` : observation.text;
  const space = rest.indexOf(" ");
  if (space === -1) return null;
  const context = rest.slice(space + 1);
  const prefix = "(agent ";
  if (!context.startsWith(prefix) || !context.endsWith(")")) return null;
  const inner = context.slice(prefix.length, -1);
  const comma = inner.lastIndexOf(", ");
  if (comma === -1) return null;
  return {
    category: observation.category,
    url: rest.slice(0, space),
    agentId: inner.slice(0, comma),
    date: inner.slice(comma + 2),
  };
}
