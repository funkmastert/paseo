import { describe, expect, it } from "vitest";
import type {
  KnowledgeBaseNoteSummary,
  KnowledgeBaseSearchResult,
} from "@getpaseo/protocol/knowledge-base/rpc-schemas";
import {
  filterKnowledgeNotesByTitle,
  orderKnowledgeNotes,
  resolveKnowledgeSearchView,
} from "./knowledge-list-model";

function note(
  overrides: Partial<KnowledgeBaseNoteSummary> & { path: string },
): KnowledgeBaseNoteSummary {
  const slug = overrides.path.replace(/\.md$/, "");
  return {
    permalink: slug,
    title: slug,
    noteType: "project",
    modifiedAt: 0,
    linkCount: 0,
    decisionCount: 0,
    ...overrides,
  };
}

const inbox = note({
  path: "inbox.md",
  title: "Inbox",
  noteType: "inbox",
  modifiedAt: 1,
  linkCount: 3,
});
const checkout = note({
  path: "projects/checkout-redesign.md",
  title: "Checkout redesign",
  modifiedAt: 300,
});
const recording = note({
  path: "projects/on-site-recording.md",
  title: "On-site recording",
  modifiedAt: 500,
});
const legacy = note({ path: "projects/legacy-import.md", title: "Legacy import", modifiedAt: 100 });
const scratch = note({
  path: "scratch/ideas.md",
  title: "Ideas",
  noteType: "note",
  modifiedAt: 900,
});
const reading = note({
  path: "reading.md",
  title: "Reading list",
  noteType: "reference",
  modifiedAt: 50,
});

const ALL = [legacy, scratch, recording, inbox, reading, checkout];

describe("orderKnowledgeNotes", () => {
  it("puts the Inbox first, then projects by last update, then every other note", () => {
    expect(orderKnowledgeNotes(ALL).map((row) => [row.kind, row.note.path])).toEqual([
      ["inbox", "inbox.md"],
      ["project", "projects/on-site-recording.md"],
      ["project", "projects/checkout-redesign.md"],
      ["project", "projects/legacy-import.md"],
      ["note", "scratch/ideas.md"],
      ["note", "reading.md"],
    ]);
  });

  it("breaks modifiedAt ties by title so the order is stable", () => {
    const a = note({ path: "projects/b.md", title: "Beta", modifiedAt: 10 });
    const b = note({ path: "projects/a.md", title: "Alpha", modifiedAt: 10 });
    expect(orderKnowledgeNotes([a, b]).map((row) => row.note.title)).toEqual(["Alpha", "Beta"]);
  });

  it("returns an empty list for an empty knowledge base", () => {
    expect(orderKnowledgeNotes([])).toEqual([]);
  });
});

describe("filterKnowledgeNotesByTitle", () => {
  it("matches the title and the permalink case-insensitively, keeping list order", () => {
    expect(filterKnowledgeNotesByTitle(ALL, "  RECORD ").map((row) => row.note.path)).toEqual([
      "projects/on-site-recording.md",
    ]);
    expect(filterKnowledgeNotesByTitle(ALL, "projects/").map((row) => row.note.path)).toEqual([
      "projects/on-site-recording.md",
      "projects/checkout-redesign.md",
      "projects/legacy-import.md",
    ]);
  });

  it("returns nothing when no title matches", () => {
    expect(filterKnowledgeNotesByTitle(ALL, "figma")).toEqual([]);
  });
});

const hit: KnowledgeBaseSearchResult = {
  path: "projects/on-site-recording.md",
  permalink: "projects/on-site-recording",
  title: "On-site recording",
  noteType: "project",
  score: 0.82,
  snippet: "- [flag] onsite_recording_v3",
};

describe("resolveKnowledgeSearchView", () => {
  it("shows the list while the query is blank", () => {
    expect(
      resolveKnowledgeSearchView({
        query: "   ",
        fullTextSearch: true,
        notes: ALL,
        search: { kind: "pending" },
      }),
    ).toEqual({ kind: "idle" });
  });

  it("shows an inline spinner while a full-text search is in flight", () => {
    expect(
      resolveKnowledgeSearchView({
        query: "flag",
        fullTextSearch: true,
        notes: ALL,
        search: { kind: "pending" },
      }),
    ).toEqual({ kind: "pending" });
  });

  it("shows full-text results, or No results", () => {
    expect(
      resolveKnowledgeSearchView({
        query: "flag",
        fullTextSearch: true,
        notes: ALL,
        search: { kind: "loaded", results: [hit] },
      }),
    ).toEqual({ kind: "results", hits: [hit] });
    expect(
      resolveKnowledgeSearchView({
        query: "flag",
        fullTextSearch: true,
        notes: ALL,
        search: { kind: "loaded", results: [] },
      }),
    ).toEqual({ kind: "empty", fullTextUnavailable: false });
  });

  it("filters loaded notes by title, with the unavailable notice, while the sidecar is not running", () => {
    expect(
      resolveKnowledgeSearchView({
        query: "checkout",
        fullTextSearch: false,
        notes: ALL,
        search: { kind: "pending" },
      }),
    ).toEqual({ kind: "title-filter", rows: [{ kind: "project", note: checkout }] });
    expect(
      resolveKnowledgeSearchView({
        query: "nothing like this",
        fullTextSearch: false,
        notes: ALL,
        search: { kind: "pending" },
      }),
    ).toEqual({ kind: "empty", fullTextUnavailable: true });
  });

  it("falls back to the title filter when the search answers search_unavailable", () => {
    expect(
      resolveKnowledgeSearchView({
        query: "legacy",
        fullTextSearch: true,
        notes: ALL,
        search: { kind: "error", code: "search_unavailable", message: "sidecar is starting" },
      }),
    ).toEqual({ kind: "title-filter", rows: [{ kind: "project", note: legacy }] });
  });

  it("shows any other search failure as an error", () => {
    expect(
      resolveKnowledgeSearchView({
        query: "legacy",
        fullTextSearch: true,
        notes: ALL,
        search: { kind: "error", code: "kb_operation_failed", message: "boom" },
      }),
    ).toEqual({ kind: "error", message: "boom" });
  });
});
