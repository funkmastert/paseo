import type {
  KnowledgeBaseBacklink,
  KnowledgeBaseGraphEdge,
  KnowledgeBaseGraphNode,
  KnowledgeBaseMergeCounts,
  KnowledgeBaseNoteSummary,
  KnowledgeBaseSearchResult,
  KnowledgeBaseSidecarStatus,
} from "@getpaseo/protocol/knowledge-base/rpc-schemas";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";

/**
 * Serves the `kb.*` RPCs (docs/knowledge-base.md, KTD-12): status, list, read, write, search,
 * graph, rename and merge. `kb.status` always answers, independent of `backend`, so the app can
 * show setup state before the feature is on. Every other handler answers `rpc_error` code
 * `"disabled"` while `backend` is null (`knowledgeBase.enabled` is false or the service is not
 * wired yet). `KnowledgeBaseService` (U5) implements `KnowledgeBaseBackend`. Return shapes reuse
 * the wire types directly (minus `requestId`) so there is one definition of each shape, not two.
 */

export interface KnowledgeBaseBackendStatus {
  enabled: boolean;
  sidecar: KnowledgeBaseSidecarStatus;
  setupHint: string | null;
}

export type KnowledgeBaseBackendNoteSummary = KnowledgeBaseNoteSummary;

export interface KnowledgeBaseBackendNote {
  path: string;
  permalink: string;
  title: string;
  noteType: string;
  content: string;
  modifiedAt: number;
  outgoingLinks: string[];
  backlinks: KnowledgeBaseBacklink[];
}

export interface KnowledgeBaseBackendWriteInput {
  path: string;
  content: string;
  expectedModifiedAt?: number | null;
}

export interface KnowledgeBaseBackendWriteResult {
  path: string;
  modifiedAt: number;
  removedSecretSpans: number;
  content: string;
}

export type KnowledgeBaseBackendSearchResult = KnowledgeBaseSearchResult;

export interface KnowledgeBaseBackendGraph {
  nodes: KnowledgeBaseGraphNode[];
  edges: KnowledgeBaseGraphEdge[];
}

export type KnowledgeBaseBackendMergeCounts = KnowledgeBaseMergeCounts;

export interface KnowledgeBaseBackendMergeResult {
  moved: KnowledgeBaseBackendMergeCounts;
  target: { path: string; permalink: string; title: string };
}

/** The small surface `KnowledgeBaseService` (U5) implements; see the file header. */
export interface KnowledgeBaseBackend {
  /** Synchronous: the sidecar's own status getter is synchronous (basic-memory-sidecar.ts). */
  isEnabled(): boolean;
  status(): KnowledgeBaseBackendStatus;
  list(): Promise<KnowledgeBaseBackendNoteSummary[]>;
  /** Null when no note exists at `path`. */
  get(path: string): Promise<KnowledgeBaseBackendNote | null>;
  /** Throws `KnowledgeBaseWriteConflictError` on a stale `expectedModifiedAt`. */
  write(input: KnowledgeBaseBackendWriteInput): Promise<KnowledgeBaseBackendWriteResult>;
  /** Throws `KnowledgeBaseSearchUnavailableError` while the sidecar is not running. */
  search(query: string): Promise<KnowledgeBaseBackendSearchResult[]>;
  graph(): Promise<KnowledgeBaseBackendGraph>;
  /** Null when `path` does not name a project note. */
  rename(input: { path: string; title: string }): Promise<KnowledgeBaseBackendNoteSummary | null>;
  /** Null when `sourcePath` or `targetPath` does not name a project note. */
  merge(input: {
    sourcePath: string;
    targetPath: string;
    dryRun: boolean;
  }): Promise<KnowledgeBaseBackendMergeResult | null>;
}

export class KnowledgeBaseWriteConflictError extends Error {
  constructor(public readonly path: string) {
    super(`Note at ${path} was modified since it was read`);
    this.name = "KnowledgeBaseWriteConflictError";
  }
}

export class KnowledgeBaseSearchUnavailableError extends Error {
  constructor(reason: string) {
    super(`Knowledge base search is unavailable: ${reason}`);
    this.name = "KnowledgeBaseSearchUnavailableError";
  }
}

const DISABLED_STATUS: KnowledgeBaseBackendStatus = {
  enabled: false,
  sidecar: { state: "disabled" },
  setupHint: "Add a knowledgeBase section to config.json and reload. See docs/knowledge-base.md.",
};

interface KnowledgeBaseSessionLogger {
  warn: (obj: object, msg?: string) => void;
}

export interface KnowledgeBaseSessionOptions {
  host: { emit: (message: SessionOutboundMessage) => void };
  logger: KnowledgeBaseSessionLogger;
  /** Null while the daemon has not wired the service (defensive; bootstrap always wires one). */
  backend: KnowledgeBaseBackend | null;
}

type DisableableRequestType = Exclude<
  Extract<SessionInboundMessage, { type: `kb.${string}.request` }>["type"],
  "kb.status.request"
>;

export class KnowledgeBaseSession {
  private readonly host: KnowledgeBaseSessionOptions["host"];
  private readonly logger: KnowledgeBaseSessionLogger;
  private readonly backend: KnowledgeBaseBackend | null;

  constructor(options: KnowledgeBaseSessionOptions) {
    this.host = options.host;
    this.logger = options.logger;
    this.backend = options.backend;
  }

  async handleStatus(
    msg: Extract<SessionInboundMessage, { type: "kb.status.request" }>,
  ): Promise<void> {
    const status = this.backend ? this.safeStatus() : DISABLED_STATUS;
    this.host.emit({
      type: "kb.status.response",
      payload: {
        requestId: msg.requestId,
        enabled: status.enabled,
        sidecar: status.sidecar,
        setupHint: status.setupHint,
      },
    });
  }

  async handleNotesList(
    msg: Extract<SessionInboundMessage, { type: "kb.notes.list.request" }>,
  ): Promise<void> {
    await this.withBackend(msg, async (backend) => {
      const notes = await backend.list();
      this.host.emit({
        type: "kb.notes.list.response",
        payload: { requestId: msg.requestId, notes },
      });
    });
  }

  async handleNoteGet(
    msg: Extract<SessionInboundMessage, { type: "kb.note.get.request" }>,
  ): Promise<void> {
    await this.withBackend(msg, async (backend) => {
      const note = await backend.get(msg.path);
      if (!note) {
        this.emitError(msg, "not_found", `No note at ${msg.path}`);
        return;
      }
      this.host.emit({
        type: "kb.note.get.response",
        payload: { requestId: msg.requestId, ...note },
      });
    });
  }

  async handleNoteWrite(
    msg: Extract<SessionInboundMessage, { type: "kb.note.write.request" }>,
  ): Promise<void> {
    await this.withBackend(msg, async (backend) => {
      try {
        const result = await backend.write({
          path: msg.path,
          content: msg.content,
          expectedModifiedAt: msg.expectedModifiedAt,
        });
        this.host.emit({
          type: "kb.note.write.response",
          payload: { requestId: msg.requestId, ...result },
        });
      } catch (error) {
        if (error instanceof KnowledgeBaseWriteConflictError) {
          this.emitError(msg, "conflict", error.message);
          return;
        }
        throw error;
      }
    });
  }

  async handleSearch(
    msg: Extract<SessionInboundMessage, { type: "kb.search.request" }>,
  ): Promise<void> {
    await this.withBackend(msg, async (backend) => {
      try {
        const results = await backend.search(msg.query);
        this.host.emit({
          type: "kb.search.response",
          payload: { requestId: msg.requestId, query: msg.query, results },
        });
      } catch (error) {
        if (error instanceof KnowledgeBaseSearchUnavailableError) {
          this.emitError(msg, "search_unavailable", error.message);
          return;
        }
        throw error;
      }
    });
  }

  async handleGraphGet(
    msg: Extract<SessionInboundMessage, { type: "kb.graph.get.request" }>,
  ): Promise<void> {
    await this.withBackend(msg, async (backend) => {
      const graph = await backend.graph();
      this.host.emit({
        type: "kb.graph.get.response",
        payload: { requestId: msg.requestId, nodes: graph.nodes, edges: graph.edges },
      });
    });
  }

  async handleProjectRename(
    msg: Extract<SessionInboundMessage, { type: "kb.project.rename.request" }>,
  ): Promise<void> {
    await this.withBackend(msg, async (backend) => {
      const renamed = await backend.rename({ path: msg.path, title: msg.title });
      if (!renamed) {
        this.emitError(msg, "not_found", `No project at ${msg.path}`);
        return;
      }
      this.host.emit({
        type: "kb.project.rename.response",
        payload: {
          requestId: msg.requestId,
          path: renamed.path,
          permalink: renamed.permalink,
          title: renamed.title,
        },
      });
    });
  }

  async handleProjectMerge(
    msg: Extract<SessionInboundMessage, { type: "kb.project.merge.request" }>,
  ): Promise<void> {
    await this.withBackend(msg, async (backend) => {
      const merged = await backend.merge({
        sourcePath: msg.sourcePath,
        targetPath: msg.targetPath,
        dryRun: msg.dryRun,
      });
      if (!merged) {
        this.emitError(msg, "not_found", "The source or target project was not found");
        return;
      }
      this.host.emit({
        type: "kb.project.merge.response",
        payload: {
          requestId: msg.requestId,
          dryRun: msg.dryRun,
          moved: merged.moved,
          target: merged.target,
        },
      });
    });
  }

  /** Runs `fn` with `this.backend`, answering `rpc_error` code `"disabled"` when it is null, and
   *  logging plus answering a generic failure for anything `fn` does not translate itself. */
  private async withBackend(
    msg: Extract<SessionInboundMessage, { type: DisableableRequestType }>,
    fn: (backend: KnowledgeBaseBackend) => Promise<void>,
  ): Promise<void> {
    if (!this.backend || !this.backend.isEnabled()) {
      this.emitError(msg, "disabled", "The knowledge base is off. Enable knowledgeBase in config.");
      return;
    }
    try {
      await fn(this.backend);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ err, type: msg.type }, "kb request failed");
      this.emitError(msg, "kb_operation_failed", err.message);
    }
  }

  private emitError(msg: { type: string; requestId: string }, code: string, error: string): void {
    this.host.emit({
      type: "rpc_error",
      payload: { requestId: msg.requestId, requestType: msg.type, error, code },
    });
  }

  private safeStatus(): KnowledgeBaseBackendStatus {
    try {
      return this.backend?.status() ?? DISABLED_STATUS;
    } catch (error) {
      this.logger.warn({ err: error }, "kb.status failed");
      return DISABLED_STATUS;
    }
  }
}

/** Always constructed, even with `backend: null`, so `kb.status` keeps answering while the
 *  daemon has the `kb.*` code but the feature is off or not yet wired. */
export function createKnowledgeBaseSession(
  options: KnowledgeBaseSessionOptions,
): KnowledgeBaseSession {
  return new KnowledgeBaseSession(options);
}
