import { describe, expect, it } from "vitest";
import {
  applyClearDraftRecord,
  moveDraftRecord,
  pruneFinalizedDraftRecords,
  toDraftInputIfReady,
  type DraftRecord,
} from "./state";

describe("draft-store lifecycle", () => {
  it("prunes finalized tombstones after TTL", () => {
    const nowMs = 1_000_000;
    const drafts = {
      oldSent: {
        input: { text: "", attachments: [] },
        lifecycle: "sent" as const,
        updatedAt: 0,
        version: 2,
      },
      recentAbandoned: {
        input: { text: "", attachments: [] },
        lifecycle: "abandoned" as const,
        updatedAt: nowMs + 2 * 60 * 1000,
        version: 2,
      },
      active: {
        input: { text: "a", attachments: [] },
        lifecycle: "active" as const,
        updatedAt: 0,
        version: 1,
      },
    };

    const pruned = pruneFinalizedDraftRecords({
      drafts,
      nowMs: nowMs + 6 * 60 * 1000,
    });

    expect(pruned.oldSent).toBeUndefined();
    expect(pruned.recentAbandoned).toBeDefined();
    expect(pruned.active).toBeDefined();
  });

  it("normalizes clear-with-lifecycle into a tombstone without attachments", () => {
    const cleared = applyClearDraftRecord({
      record: {
        input: {
          text: "hello",
          attachments: [
            {
              kind: "image",
              metadata: {
                id: "att-1",
                mimeType: "image/jpeg",
                storageType: "web-indexeddb",
                storageKey: "att-1",
                createdAt: 1,
              },
            },
          ],
        },
        lifecycle: "active",
        updatedAt: 1,
        version: 1,
      },
      lifecycle: "sent",
      nowMs: 2,
    });

    expect(cleared).toEqual({
      input: { text: "", attachments: [] },
      lifecycle: "sent",
      updatedAt: 2,
      version: 2,
    });
  });
});

describe("draft-store normalization", () => {
  it("preserves plugin resources when hydrating a draft", () => {
    const attachment = {
      kind: "plugin_resource" as const,
      pluginId: "linear",
      sourceId: "issues",
      sourceTitle: "Linear issue",
      sourceIcon: "CircleDot",
      item: {
        id: "issue-uuid",
        identifier: "ENG-123",
        title: "Plugin attachments",
        subtitle: "In progress",
        url: "https://linear.app/acme/issue/ENG-123/plugin-attachments",
        text: "Linear issue ENG-123: Plugin attachments",
        resourceType: "issue",
      },
    };

    expect(
      toDraftInputIfReady({
        input: { text: "Implement this", attachments: [attachment] },
        lifecycle: "active",
        updatedAt: 1,
        version: 1,
      }),
    ).toEqual({ text: "Implement this", attachments: [attachment] });
  });

  it("preserves uploaded file attachments when hydrating a draft", () => {
    const attachment = {
      kind: "file" as const,
      attachment: {
        type: "uploaded_file" as const,
        id: "file-1",
        fileName: "context.json",
        mimeType: "application/json",
        size: 42,
        path: "/tmp/context.json",
      },
    };

    expect(
      toDraftInputIfReady({
        input: { text: "Review this", attachments: [attachment] },
        lifecycle: "active",
        updatedAt: 1,
        version: 1,
      }),
    ).toEqual({ text: "Review this", attachments: [attachment] });
  });

  it("preserves workspace file selections when hydrating a draft", () => {
    const attachment = {
      kind: "workspace_file" as const,
      path: "src/app.ts",
      selection: { kind: "line_range" as const, startLine: 12, endLine: 24 },
    };

    expect(
      toDraftInputIfReady({
        input: { text: "Review this", attachments: [attachment] },
        lifecycle: "active",
        updatedAt: 1,
        version: 1,
      }),
    ).toEqual({ text: "Review this", attachments: [attachment] });
  });

  it("preserves New Workspace picker ownership when hydrating a draft", () => {
    const pickerAttachment = {
      kind: "github_pr" as const,
      owner: "new-workspace-picker" as const,
      item: {
        kind: "change_request" as const,
        number: 202,
        title: "Persist picker ownership",
        url: "https://example.com/pull/202",
        state: "open" as const,
        body: null,
        labels: [],
        baseRefName: "main",
        headRefName: "feature/picker-ownership",
      },
    };

    expect(
      toDraftInputIfReady({
        input: { text: "Keep this prompt", attachments: [pickerAttachment] },
        lifecycle: "active",
        updatedAt: 1,
        version: 1,
      }),
    ).toEqual({
      text: "Keep this prompt",
      attachments: [pickerAttachment],
    });
  });
});

describe("moveDraftRecord", () => {
  function record(text: string, lifecycle: DraftRecord["lifecycle"] = "active"): DraftRecord {
    return { input: { text, attachments: [] }, lifecycle, updatedAt: 1, version: 3 };
  }

  it("moves an unsent draft to a key that has none and clears the old key", () => {
    expect(
      moveDraftRecord({
        drafts: { from: record("half typed") },
        fromKey: "from",
        toKey: "to",
        nowMs: 50,
      }),
    ).toEqual({
      to: {
        input: { text: "half typed", attachments: [] },
        lifecycle: "active",
        updatedAt: 50,
        version: 1,
      },
    });
  });

  it("keeps the destination's own unsent draft and drops the old one", () => {
    expect(
      moveDraftRecord({
        drafts: { from: record("old"), to: record("newer") },
        fromKey: "from",
        toKey: "to",
        nowMs: 50,
      }),
    ).toEqual({ to: record("newer") });
  });

  it("replaces an empty or finalized destination record", () => {
    expect(
      moveDraftRecord({
        drafts: { from: record("keep me"), to: record("", "sent") },
        fromKey: "from",
        toKey: "to",
        nowMs: 50,
      }),
    ).toEqual({
      to: {
        input: { text: "keep me", attachments: [] },
        lifecycle: "active",
        updatedAt: 50,
        version: 4,
      },
    });
  });

  it("does not carry a finalized draft and still clears the old key", () => {
    expect(
      moveDraftRecord({
        drafts: { from: record("", "sent") },
        fromKey: "from",
        toKey: "to",
        nowMs: 50,
      }),
    ).toEqual({});
  });

  it("returns the same map when the old key has nothing", () => {
    const drafts = { other: record("x") };
    expect(moveDraftRecord({ drafts, fromKey: "from", toKey: "to", nowMs: 50 })).toBe(drafts);
  });
});
