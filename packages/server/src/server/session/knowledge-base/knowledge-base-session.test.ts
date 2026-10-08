import { describe, expect, it, vi } from "vitest";
import type { SessionOutboundMessage } from "../../messages.js";
import {
  type KnowledgeBaseBackend,
  type KnowledgeBaseBackendGraph,
  type KnowledgeBaseBackendMergeResult,
  type KnowledgeBaseBackendNote,
  type KnowledgeBaseBackendNoteSummary,
  type KnowledgeBaseBackendSearchResult,
  type KnowledgeBaseBackendStatus,
  KnowledgeBaseSearchUnavailableError,
  KnowledgeBaseSession,
  KnowledgeBaseWriteConflictError,
} from "./knowledge-base-session.js";

const NOTE_SUMMARY: KnowledgeBaseBackendNoteSummary = {
  path: "projects/checkout-redesign.md",
  permalink: "projects/checkout-redesign",
  title: "Checkout redesign",
  noteType: "project",
  modifiedAt: 1_700_000_000_000,
  linkCount: 2,
  decisionCount: 1,
};

const NOTE: KnowledgeBaseBackendNote = {
  path: NOTE_SUMMARY.path,
  permalink: NOTE_SUMMARY.permalink,
  title: NOTE_SUMMARY.title,
  noteType: NOTE_SUMMARY.noteType,
  content: "---\ntitle: Checkout redesign\n---\n## Summary\n",
  modifiedAt: NOTE_SUMMARY.modifiedAt,
  outgoingLinks: [],
  backlinks: [],
};

const RUNNING_STATUS: KnowledgeBaseBackendStatus = {
  enabled: true,
  sidecar: { state: "running", since: 1, pid: 42, version: "0.23.2", stderrTail: [] },
  setupHint: null,
};

function fakeBackend(overrides: Partial<KnowledgeBaseBackend> = {}): KnowledgeBaseBackend {
  return {
    isEnabled: () => true,
    status: () => RUNNING_STATUS,
    list: async () => [NOTE_SUMMARY],
    get: async (path) => (path === NOTE.path ? NOTE : null),
    write: async ({ path, content }) => ({
      path,
      modifiedAt: 1_700_000_000_001,
      removedSecretSpans: 0,
      content,
    }),
    search: async (query) => [
      { ...NOTE_SUMMARY, score: 0.9, snippet: query } satisfies KnowledgeBaseBackendSearchResult,
    ],
    graph: async () =>
      ({
        nodes: [{ ...NOTE_SUMMARY, linkCount: 2 }],
        edges: [],
      }) satisfies KnowledgeBaseBackendGraph,
    rename: async ({ path, title }) => (path === NOTE.path ? { ...NOTE_SUMMARY, title } : null),
    merge: async () =>
      ({
        moved: { links: 2, decisions: 1, rules: 0, agents: 1, workspaces: 0 },
        target: { path: NOTE.path, permalink: NOTE.permalink, title: NOTE.title },
      }) satisfies KnowledgeBaseBackendMergeResult,
    ...overrides,
  };
}

function createSession(backend: KnowledgeBaseBackend | null) {
  const emitted: SessionOutboundMessage[] = [];
  const session = new KnowledgeBaseSession({
    host: { emit: (message) => void emitted.push(message) },
    logger: { warn: vi.fn() },
    backend,
  });
  return { session, emitted };
}

describe("KnowledgeBaseSession", () => {
  describe("kb.status", () => {
    it("always answers, even with no backend", async () => {
      const { session, emitted } = createSession(null);
      await session.handleStatus({ type: "kb.status.request", requestId: "r1" });
      expect(emitted[0]).toMatchObject({
        type: "kb.status.response",
        payload: { requestId: "r1", enabled: false, sidecar: { state: "disabled" } },
      });
      const payload = (emitted[0] as { payload: { setupHint: string | null } }).payload;
      expect(payload.setupHint).not.toBeNull();
    });

    it("reports the backend's status when present", async () => {
      const { session, emitted } = createSession(fakeBackend());
      await session.handleStatus({ type: "kb.status.request", requestId: "r1" });
      expect(emitted[0]).toMatchObject({
        type: "kb.status.response",
        payload: { requestId: "r1", enabled: true, sidecar: { state: "running", pid: 42 } },
      });
    });
  });

  describe("while the feature is off", () => {
    it("answers every other handler with a disabled rpc_error", async () => {
      const { session, emitted } = createSession(null);
      await session.handleNotesList({ type: "kb.notes.list.request", requestId: "r1" });
      await session.handleNoteGet({
        type: "kb.note.get.request",
        requestId: "r2",
        path: "inbox.md",
      });
      await session.handleNoteWrite({
        type: "kb.note.write.request",
        requestId: "r3",
        path: "inbox.md",
        content: "x",
      });
      await session.handleSearch({ type: "kb.search.request", requestId: "r4", query: "x" });
      await session.handleGraphGet({ type: "kb.graph.get.request", requestId: "r5" });
      await session.handleProjectRename({
        type: "kb.project.rename.request",
        requestId: "r6",
        path: "projects/a.md",
        title: "A",
      });
      await session.handleProjectMerge({
        type: "kb.project.merge.request",
        requestId: "r7",
        sourcePath: "projects/a.md",
        targetPath: "projects/b.md",
        dryRun: true,
      });

      expect(emitted).toHaveLength(7);
      for (const message of emitted) {
        expect(message).toMatchObject({ type: "rpc_error", payload: { code: "disabled" } });
      }
    });

    it("also disables when the backend reports itself disabled", async () => {
      const { session, emitted } = createSession(fakeBackend({ isEnabled: () => false }));
      await session.handleNotesList({ type: "kb.notes.list.request", requestId: "r1" });
      expect(emitted[0]).toMatchObject({ type: "rpc_error", payload: { code: "disabled" } });
    });
  });

  describe("kb.notes.list", () => {
    it("relays the backend's list", async () => {
      const { session, emitted } = createSession(fakeBackend());
      await session.handleNotesList({ type: "kb.notes.list.request", requestId: "r1" });
      expect(emitted[0]).toEqual({
        type: "kb.notes.list.response",
        payload: { requestId: "r1", notes: [NOTE_SUMMARY] },
      });
    });
  });

  describe("kb.note.get", () => {
    it("relays the note", async () => {
      const { session, emitted } = createSession(fakeBackend());
      await session.handleNoteGet({
        type: "kb.note.get.request",
        requestId: "r1",
        path: NOTE.path,
      });
      expect(emitted[0]).toEqual({
        type: "kb.note.get.response",
        payload: { requestId: "r1", ...NOTE },
      });
    });

    it("answers not_found for a missing note", async () => {
      const { session, emitted } = createSession(fakeBackend());
      await session.handleNoteGet({
        type: "kb.note.get.request",
        requestId: "r1",
        path: "missing.md",
      });
      expect(emitted[0]).toMatchObject({ type: "rpc_error", payload: { code: "not_found" } });
    });
  });

  describe("kb.note.write", () => {
    it("relays a successful write, including the scrubbed content", async () => {
      const { session, emitted } = createSession(fakeBackend());
      await session.handleNoteWrite({
        type: "kb.note.write.request",
        requestId: "r1",
        path: "inbox.md",
        content: "new content",
      });
      expect(emitted[0]).toEqual({
        type: "kb.note.write.response",
        payload: {
          requestId: "r1",
          path: "inbox.md",
          modifiedAt: 1_700_000_000_001,
          removedSecretSpans: 0,
          content: "new content",
        },
      });
    });

    it("answers conflict for a stale expectedModifiedAt", async () => {
      const backend = fakeBackend({
        write: async () => {
          throw new KnowledgeBaseWriteConflictError("inbox.md");
        },
      });
      const { session, emitted } = createSession(backend);
      await session.handleNoteWrite({
        type: "kb.note.write.request",
        requestId: "r1",
        path: "inbox.md",
        content: "x",
        expectedModifiedAt: 1,
      });
      expect(emitted[0]).toMatchObject({ type: "rpc_error", payload: { code: "conflict" } });
    });
  });

  describe("kb.search", () => {
    it("relays results", async () => {
      const { session, emitted } = createSession(fakeBackend());
      await session.handleSearch({ type: "kb.search.request", requestId: "r1", query: "checkout" });
      expect(emitted[0]).toMatchObject({
        type: "kb.search.response",
        payload: { requestId: "r1", query: "checkout", results: [{ snippet: "checkout" }] },
      });
    });

    it("answers search_unavailable when the sidecar is down", async () => {
      const backend = fakeBackend({
        search: async () => {
          throw new KnowledgeBaseSearchUnavailableError("starting");
        },
      });
      const { session, emitted } = createSession(backend);
      await session.handleSearch({ type: "kb.search.request", requestId: "r1", query: "x" });
      expect(emitted[0]).toMatchObject({
        type: "rpc_error",
        payload: { code: "search_unavailable" },
      });
    });
  });

  describe("kb.graph.get", () => {
    it("relays nodes and edges", async () => {
      const { session, emitted } = createSession(fakeBackend());
      await session.handleGraphGet({ type: "kb.graph.get.request", requestId: "r1" });
      expect(emitted[0]).toMatchObject({
        type: "kb.graph.get.response",
        payload: { requestId: "r1", nodes: [{ path: NOTE.path }], edges: [] },
      });
    });
  });

  describe("kb.project.rename", () => {
    it("relays the renamed project", async () => {
      const { session, emitted } = createSession(fakeBackend());
      await session.handleProjectRename({
        type: "kb.project.rename.request",
        requestId: "r1",
        path: NOTE.path,
        title: "New title",
      });
      expect(emitted[0]).toMatchObject({
        type: "kb.project.rename.response",
        payload: { requestId: "r1", title: "New title" },
      });
    });

    it("answers not_found for a missing project", async () => {
      const { session, emitted } = createSession(fakeBackend());
      await session.handleProjectRename({
        type: "kb.project.rename.request",
        requestId: "r1",
        path: "projects/missing.md",
        title: "New title",
      });
      expect(emitted[0]).toMatchObject({ type: "rpc_error", payload: { code: "not_found" } });
    });
  });

  describe("kb.project.merge", () => {
    it("passes dryRun through and changes nothing on a dry run", async () => {
      const write = vi.fn();
      const backend = fakeBackend({ write });
      const { session, emitted } = createSession(backend);
      await session.handleProjectMerge({
        type: "kb.project.merge.request",
        requestId: "r1",
        sourcePath: "projects/b.md",
        targetPath: "projects/a.md",
        dryRun: true,
      });
      expect(write).not.toHaveBeenCalled();
      expect(emitted[0]).toMatchObject({
        type: "kb.project.merge.response",
        payload: { requestId: "r1", dryRun: true, moved: { links: 2, agents: 1 } },
      });
    });

    it("answers not_found when the source or target project is missing", async () => {
      const backend = fakeBackend({ merge: async () => null });
      const { session, emitted } = createSession(backend);
      await session.handleProjectMerge({
        type: "kb.project.merge.request",
        requestId: "r1",
        sourcePath: "projects/b.md",
        targetPath: "projects/a.md",
        dryRun: false,
      });
      expect(emitted[0]).toMatchObject({ type: "rpc_error", payload: { code: "not_found" } });
    });
  });

  describe("an unexpected backend failure", () => {
    it("is logged and answered as a generic rpc_error, not thrown", async () => {
      const logger = { warn: vi.fn() };
      const backend = fakeBackend({
        list: async () => {
          throw new Error("disk exploded");
        },
      });
      const emitted: SessionOutboundMessage[] = [];
      const session = new KnowledgeBaseSession({
        host: { emit: (message) => void emitted.push(message) },
        logger,
        backend,
      });
      await session.handleNotesList({ type: "kb.notes.list.request", requestId: "r1" });
      expect(emitted[0]).toMatchObject({
        type: "rpc_error",
        payload: { code: "kb_operation_failed", error: "disk exploded" },
      });
      expect(logger.warn).toHaveBeenCalled();
    });
  });
});
