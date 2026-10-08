import type {
  KnowledgeBaseNoteSummary,
  KnowledgeBaseSearchResult,
} from "@getpaseo/protocol/knowledge-base/rpc-schemas";

export type KnowledgeNoteKind = "inbox" | "project" | "note";

export interface KnowledgeListRow {
  kind: KnowledgeNoteKind;
  note: KnowledgeBaseNoteSummary;
}

export function knowledgeNoteKind(noteType: string): KnowledgeNoteKind {
  if (noteType === "inbox") return "inbox";
  if (noteType === "project") return "project";
  return "note";
}

const KIND_RANK: Record<KnowledgeNoteKind, number> = { inbox: 0, project: 1, note: 2 };

/** The Inbox first, then projects by last update, then every other note by last update. */
export function orderKnowledgeNotes(
  notes: readonly KnowledgeBaseNoteSummary[],
): KnowledgeListRow[] {
  const rows = notes.map((note) => ({ kind: knowledgeNoteKind(note.noteType), note }));
  return rows.sort(compareRows);
}

function compareRows(a: KnowledgeListRow, b: KnowledgeListRow): number {
  const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (byKind !== 0) return byKind;
  const byRecency = b.note.modifiedAt - a.note.modifiedAt;
  if (byRecency !== 0) return byRecency;
  return a.note.title.localeCompare(b.note.title);
}

/**
 * Search while Basic Memory is not running. The note list carries no aliases, so a project
 * renamed since is found by its permalink until the list grows them.
 */
export function filterKnowledgeNotesByTitle(
  notes: readonly KnowledgeBaseNoteSummary[],
  query: string,
): KnowledgeListRow[] {
  const needle = query.trim().toLowerCase();
  return orderKnowledgeNotes(notes).filter(
    (row) =>
      row.note.title.toLowerCase().includes(needle) ||
      row.note.permalink.toLowerCase().includes(needle),
  );
}

export type KnowledgeSearchState =
  | { kind: "pending" }
  | { kind: "loaded"; results: readonly KnowledgeBaseSearchResult[] }
  | { kind: "error"; code: string | null; message: string };

export type KnowledgeSearchView =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "results"; hits: readonly KnowledgeBaseSearchResult[] }
  | { kind: "title-filter"; rows: KnowledgeListRow[] }
  | { kind: "empty"; fullTextUnavailable: boolean }
  | { kind: "error"; message: string };

export interface KnowledgeSearchViewInput {
  query: string;
  fullTextSearch: boolean;
  notes: readonly KnowledgeBaseNoteSummary[];
  search: KnowledgeSearchState;
}

export function resolveKnowledgeSearchView(input: KnowledgeSearchViewInput): KnowledgeSearchView {
  if (input.query.trim().length === 0) return { kind: "idle" };
  const searchUnavailable =
    input.search.kind === "error" && input.search.code === "search_unavailable";
  if (!input.fullTextSearch || searchUnavailable) {
    const rows = filterKnowledgeNotesByTitle(input.notes, input.query);
    if (rows.length === 0) return { kind: "empty", fullTextUnavailable: true };
    return { kind: "title-filter", rows };
  }
  switch (input.search.kind) {
    case "pending":
      return { kind: "pending" };
    case "error":
      return { kind: "error", message: input.search.message };
    case "loaded":
      if (input.search.results.length === 0) return { kind: "empty", fullTextUnavailable: false };
      return { kind: "results", hits: input.search.results };
  }
}
