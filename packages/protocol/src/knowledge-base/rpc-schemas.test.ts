import { describe, expect, it } from "vitest";
import {
  KnowledgeBaseGraphGetRequestSchema,
  KnowledgeBaseGraphGetResponseSchema,
  KnowledgeBaseNoteGetRequestSchema,
  KnowledgeBaseNoteGetResponseSchema,
  KnowledgeBaseNoteWriteRequestSchema,
  KnowledgeBaseNoteWriteResponseSchema,
  KnowledgeBaseNotesListRequestSchema,
  KnowledgeBaseNotesListResponseSchema,
  KnowledgeBaseProjectMergeRequestSchema,
  KnowledgeBaseProjectMergeResponseSchema,
  KnowledgeBaseProjectRenameRequestSchema,
  KnowledgeBaseProjectRenameResponseSchema,
  KnowledgeBaseSearchRequestSchema,
  KnowledgeBaseSearchResponseSchema,
  KnowledgeBaseSidecarStatusSchema,
  KnowledgeBaseStatusRequestSchema,
  KnowledgeBaseStatusResponseSchema,
} from "./rpc-schemas.js";

describe("kb.status", () => {
  it("round-trips a request with only its required fields", () => {
    expect(
      KnowledgeBaseStatusRequestSchema.parse({ type: "kb.status.request", requestId: "r1" }),
    ).toEqual({ type: "kb.status.request", requestId: "r1" });
  });

  it("round-trips every sidecar status branch", () => {
    const branches = [
      { state: "disabled" },
      { state: "missing", command: "basic-memory", hint: "run paseo kb setup" },
      { state: "starting", since: 1 },
      { state: "running", since: 1, pid: 123, version: "0.23.2", stderrTail: ["line"] },
      {
        state: "backoff",
        error: "exited",
        stderrTail: [],
        attempt: 1,
        delayMs: 2000,
        retryAt: 5000,
      },
    ];
    for (const sidecar of branches) {
      expect(KnowledgeBaseSidecarStatusSchema.parse(sidecar)).toEqual(sidecar);
      const response = KnowledgeBaseStatusResponseSchema.parse({
        type: "kb.status.response",
        payload: { requestId: "r1", enabled: true, sidecar, setupHint: null },
      });
      expect(response.payload.sidecar).toEqual(sidecar);
    }
  });

  it("round-trips a disabled response with a setup hint", () => {
    expect(
      KnowledgeBaseStatusResponseSchema.parse({
        type: "kb.status.response",
        payload: {
          requestId: "r1",
          enabled: false,
          sidecar: { state: "disabled" },
          setupHint: "Add a knowledgeBase section to config.json",
        },
      }).payload.enabled,
    ).toBe(false);
  });
});

describe("kb.notes.list", () => {
  it("round-trips request and response", () => {
    expect(
      KnowledgeBaseNotesListRequestSchema.parse({
        type: "kb.notes.list.request",
        requestId: "r1",
      }),
    ).toEqual({ type: "kb.notes.list.request", requestId: "r1" });

    const note = {
      path: "projects/checkout-redesign.md",
      permalink: "projects/checkout-redesign",
      title: "Checkout redesign",
      noteType: "project",
      modifiedAt: 1700000000000,
      linkCount: 2,
      decisionCount: 1,
    };
    expect(
      KnowledgeBaseNotesListResponseSchema.parse({
        type: "kb.notes.list.response",
        payload: { requestId: "r1", notes: [note] },
      }).payload.notes,
    ).toEqual([note]);
  });

  it("round-trips a note's aliases when present", () => {
    const withAliases = {
      path: "projects/checkout-revamp.md",
      permalink: "projects/checkout-revamp",
      title: "Checkout revamp",
      noteType: "project",
      modifiedAt: 1700000000000,
      linkCount: 0,
      decisionCount: 0,
      aliases: ["Checkout redesign"],
    };
    const parsed = KnowledgeBaseNotesListResponseSchema.parse({
      type: "kb.notes.list.response",
      payload: { requestId: "r1", notes: [withAliases] },
    }).payload.notes[0];
    expect(parsed).toEqual(withAliases);
  });

  it("leaves aliases undefined when the note carries none", () => {
    const noAliases = {
      path: "inbox.md",
      permalink: "inbox",
      title: "Inbox",
      noteType: "inbox",
      modifiedAt: 1700000000000,
      linkCount: 0,
      decisionCount: 0,
    };
    const parsed = KnowledgeBaseNotesListResponseSchema.parse({
      type: "kb.notes.list.response",
      payload: { requestId: "r1", notes: [noAliases] },
    }).payload.notes[0];
    expect(parsed?.aliases).toBeUndefined();
  });
});

describe("kb.note.get", () => {
  it("round-trips request and a response with links and backlinks", () => {
    expect(
      KnowledgeBaseNoteGetRequestSchema.parse({
        type: "kb.note.get.request",
        requestId: "r1",
        path: "inbox.md",
      }),
    ).toEqual({ type: "kb.note.get.request", requestId: "r1", path: "inbox.md" });

    const payload = {
      requestId: "r1",
      path: "inbox.md",
      permalink: "inbox",
      title: "Inbox",
      noteType: "inbox",
      content: "---\ntitle: Inbox\n---\n",
      modifiedAt: 1700000000000,
      outgoingLinks: ["Checkout redesign"],
      backlinks: [{ path: "projects/checkout-redesign.md", title: "Checkout redesign" }],
    };
    expect(
      KnowledgeBaseNoteGetResponseSchema.parse({ type: "kb.note.get.response", payload }).payload,
    ).toEqual(payload);
  });
});

describe("kb.note.write", () => {
  it("round-trips a write with no expectedModifiedAt", () => {
    expect(
      KnowledgeBaseNoteWriteRequestSchema.parse({
        type: "kb.note.write.request",
        requestId: "r1",
        path: "inbox.md",
        content: "new content",
      }),
    ).toEqual({
      type: "kb.note.write.request",
      requestId: "r1",
      path: "inbox.md",
      content: "new content",
    });
  });

  it("round-trips expectedModifiedAt as a number and as null", () => {
    expect(
      KnowledgeBaseNoteWriteRequestSchema.parse({
        type: "kb.note.write.request",
        requestId: "r1",
        path: "inbox.md",
        content: "x",
        expectedModifiedAt: 1700000000000,
      }).expectedModifiedAt,
    ).toBe(1700000000000);

    expect(
      KnowledgeBaseNoteWriteRequestSchema.parse({
        type: "kb.note.write.request",
        requestId: "r1",
        path: "inbox.md",
        content: "x",
        expectedModifiedAt: null,
      }).expectedModifiedAt,
    ).toBeNull();
  });

  it("round-trips the response", () => {
    const payload = {
      requestId: "r1",
      path: "inbox.md",
      modifiedAt: 1700000000001,
      removedSecretSpans: 1,
      content: "scrubbed content",
    };
    expect(
      KnowledgeBaseNoteWriteResponseSchema.parse({ type: "kb.note.write.response", payload })
        .payload,
    ).toEqual(payload);
  });
});

describe("kb.search", () => {
  it("round-trips request and response", () => {
    expect(
      KnowledgeBaseSearchRequestSchema.parse({
        type: "kb.search.request",
        requestId: "r1",
        query: "checkout",
      }),
    ).toEqual({ type: "kb.search.request", requestId: "r1", query: "checkout" });

    const result = {
      path: "projects/checkout-redesign.md",
      permalink: "projects/checkout-redesign",
      title: "Checkout redesign",
      noteType: "project",
      score: 0.91,
      snippet: "…checkout…",
    };
    expect(
      KnowledgeBaseSearchResponseSchema.parse({
        type: "kb.search.response",
        payload: { requestId: "r1", query: "checkout", results: [result] },
      }).payload.results,
    ).toEqual([result]);
  });
});

describe("kb.graph.get", () => {
  it("round-trips request and response", () => {
    expect(
      KnowledgeBaseGraphGetRequestSchema.parse({ type: "kb.graph.get.request", requestId: "r1" }),
    ).toEqual({ type: "kb.graph.get.request", requestId: "r1" });

    const node = {
      path: "inbox.md",
      permalink: "inbox",
      title: "Inbox",
      noteType: "inbox",
      linkCount: 3,
    };
    const edge = { source: "inbox.md", target: "projects/checkout-redesign.md" };
    expect(
      KnowledgeBaseGraphGetResponseSchema.parse({
        type: "kb.graph.get.response",
        payload: { requestId: "r1", nodes: [node], edges: [edge] },
      }).payload,
    ).toEqual({ requestId: "r1", nodes: [node], edges: [edge] });
  });
});

describe("kb.project.rename", () => {
  it("round-trips request and response", () => {
    expect(
      KnowledgeBaseProjectRenameRequestSchema.parse({
        type: "kb.project.rename.request",
        requestId: "r1",
        path: "projects/checkout-redesign.md",
        title: "Checkout redesign v2",
      }),
    ).toEqual({
      type: "kb.project.rename.request",
      requestId: "r1",
      path: "projects/checkout-redesign.md",
      title: "Checkout redesign v2",
    });

    const payload = {
      requestId: "r1",
      path: "projects/checkout-redesign-v2.md",
      permalink: "projects/checkout-redesign-v2",
      title: "Checkout redesign v2",
    };
    expect(
      KnowledgeBaseProjectRenameResponseSchema.parse({
        type: "kb.project.rename.response",
        payload,
      }).payload,
    ).toEqual(payload);
  });
});

describe("kb.project.merge", () => {
  it("round-trips a dry-run request and response", () => {
    expect(
      KnowledgeBaseProjectMergeRequestSchema.parse({
        type: "kb.project.merge.request",
        requestId: "r1",
        sourcePath: "projects/b.md",
        targetPath: "projects/a.md",
        dryRun: true,
      }),
    ).toEqual({
      type: "kb.project.merge.request",
      requestId: "r1",
      sourcePath: "projects/b.md",
      targetPath: "projects/a.md",
      dryRun: true,
    });

    const payload = {
      requestId: "r1",
      dryRun: true,
      moved: { links: 2, decisions: 1, rules: 0, agents: 3, workspaces: 1 },
      target: { path: "projects/a.md", permalink: "projects/a", title: "A" },
    };
    expect(
      KnowledgeBaseProjectMergeResponseSchema.parse({ type: "kb.project.merge.response", payload })
        .payload,
    ).toEqual(payload);
  });
});
