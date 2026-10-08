import { z } from "zod";

/**
 * The `kb.*` namespace (docs/knowledge-base.md, KTD-12): the app's read and edit surface on the
 * project knowledge base. Gated on `server_info.features.knowledgeBase`
 * (COMPAT(knowledgeBase): added in v0.8.x, remove gate after 2027-10-07). `kb.status` always
 * answers so the app can show setup state; every other RPC answers `rpc_error` with code
 * `"disabled"` while `knowledgeBase.enabled` is false. Reads need `workspace.read`, writes need
 * `workspace.write` (docs/permissions.md).
 */

// --- Shared shapes -----------------------------------------------------------

/**
 * Mirrors `BasicMemorySidecarStatus` (server/knowledge-base/basic-memory-sidecar.ts) on the wire.
 * Declared independently here: protocol schemas do not import server types.
 */
export const KnowledgeBaseSidecarStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("disabled") }),
  z.object({ state: z.literal("missing"), command: z.string(), hint: z.string() }),
  z.object({ state: z.literal("starting"), since: z.number() }),
  z.object({
    state: z.literal("running"),
    since: z.number(),
    pid: z.number().nullable(),
    version: z.string().nullable(),
    stderrTail: z.array(z.string()),
  }),
  z.object({
    state: z.literal("backoff"),
    error: z.string(),
    stderrTail: z.array(z.string()),
    attempt: z.number(),
    delayMs: z.number(),
    retryAt: z.number(),
  }),
]);

export const KnowledgeBaseNoteSummarySchema = z.object({
  path: z.string(),
  permalink: z.string(),
  title: z.string(),
  /** The note's frontmatter `type` (`"project"`, `"inbox"`, or anything else Obsidian wrote). */
  noteType: z.string(),
  modifiedAt: z.number(),
  linkCount: z.number().int().nonnegative(),
  decisionCount: z.number().int().nonnegative(),
});

export const KnowledgeBaseBacklinkSchema = z.object({
  path: z.string(),
  title: z.string(),
});

export const KnowledgeBaseSearchResultSchema = z.object({
  path: z.string(),
  permalink: z.string(),
  title: z.string(),
  noteType: z.string(),
  score: z.number(),
  snippet: z.string(),
});

export const KnowledgeBaseGraphNodeSchema = z.object({
  path: z.string(),
  permalink: z.string(),
  title: z.string(),
  noteType: z.string(),
  linkCount: z.number().int().nonnegative(),
});

export const KnowledgeBaseGraphEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
});

export const KnowledgeBaseMergeCountsSchema = z.object({
  links: z.number().int().nonnegative(),
  decisions: z.number().int().nonnegative(),
  rules: z.number().int().nonnegative(),
  agents: z.number().int().nonnegative(),
  workspaces: z.number().int().nonnegative(),
});

// --- kb.status -----------------------------------------------------------------

export const KnowledgeBaseStatusRequestSchema = z.object({
  type: z.literal("kb.status.request"),
  requestId: z.string(),
});

export const KnowledgeBaseStatusResponseSchema = z.object({
  type: z.literal("kb.status.response"),
  payload: z.object({
    requestId: z.string(),
    enabled: z.boolean(),
    sidecar: KnowledgeBaseSidecarStatusSchema,
    /** How Tyler turns it on or fixes it; null once it is enabled and the sidecar is healthy. */
    setupHint: z.string().nullable(),
  }),
});

// --- kb.notes.list --------------------------------------------------------------

export const KnowledgeBaseNotesListRequestSchema = z.object({
  type: z.literal("kb.notes.list.request"),
  requestId: z.string(),
});

export const KnowledgeBaseNotesListResponseSchema = z.object({
  type: z.literal("kb.notes.list.response"),
  payload: z.object({
    requestId: z.string(),
    notes: z.array(KnowledgeBaseNoteSummarySchema),
  }),
});

// --- kb.note.get ----------------------------------------------------------------

export const KnowledgeBaseNoteGetRequestSchema = z.object({
  type: z.literal("kb.note.get.request"),
  requestId: z.string(),
  path: z.string(),
});

export const KnowledgeBaseNoteGetResponseSchema = z.object({
  type: z.literal("kb.note.get.response"),
  payload: z.object({
    requestId: z.string(),
    path: z.string(),
    permalink: z.string(),
    title: z.string(),
    noteType: z.string(),
    content: z.string(),
    modifiedAt: z.number(),
    outgoingLinks: z.array(z.string()),
    backlinks: z.array(KnowledgeBaseBacklinkSchema),
  }),
});

// --- kb.note.write --------------------------------------------------------------

export const KnowledgeBaseNoteWriteRequestSchema = z.object({
  type: z.literal("kb.note.write.request"),
  requestId: z.string(),
  path: z.string(),
  content: z.string(),
  /**
   * Omit to overwrite blindly (the view's Overwrite action). Pass the `modifiedAt` from a prior
   * `kb.note.get` to require the file be unchanged since, or `null` to require it not yet exist.
   */
  expectedModifiedAt: z.number().nullable().optional(),
});

export const KnowledgeBaseNoteWriteResponseSchema = z.object({
  type: z.literal("kb.note.write.response"),
  payload: z.object({
    requestId: z.string(),
    path: z.string(),
    modifiedAt: z.number(),
    removedSecretSpans: z.number().int().nonnegative(),
    /** The scrubbed text as written; the editor adopts this as its saved state. */
    content: z.string(),
  }),
});

// --- kb.search --------------------------------------------------------------------

export const KnowledgeBaseSearchRequestSchema = z.object({
  type: z.literal("kb.search.request"),
  requestId: z.string(),
  query: z.string(),
});

export const KnowledgeBaseSearchResponseSchema = z.object({
  type: z.literal("kb.search.response"),
  payload: z.object({
    requestId: z.string(),
    query: z.string(),
    results: z.array(KnowledgeBaseSearchResultSchema),
  }),
});

// --- kb.graph.get -----------------------------------------------------------------

export const KnowledgeBaseGraphGetRequestSchema = z.object({
  type: z.literal("kb.graph.get.request"),
  requestId: z.string(),
});

export const KnowledgeBaseGraphGetResponseSchema = z.object({
  type: z.literal("kb.graph.get.response"),
  payload: z.object({
    requestId: z.string(),
    nodes: z.array(KnowledgeBaseGraphNodeSchema),
    edges: z.array(KnowledgeBaseGraphEdgeSchema),
  }),
});

// --- kb.project.rename -------------------------------------------------------------

export const KnowledgeBaseProjectRenameRequestSchema = z.object({
  type: z.literal("kb.project.rename.request"),
  requestId: z.string(),
  path: z.string(),
  title: z.string(),
});

export const KnowledgeBaseProjectRenameResponseSchema = z.object({
  type: z.literal("kb.project.rename.response"),
  payload: z.object({
    requestId: z.string(),
    path: z.string(),
    permalink: z.string(),
    title: z.string(),
  }),
});

// --- kb.project.merge --------------------------------------------------------------

export const KnowledgeBaseProjectMergeRequestSchema = z.object({
  type: z.literal("kb.project.merge.request"),
  requestId: z.string(),
  sourcePath: z.string(),
  targetPath: z.string(),
  /** When true, nothing is written; the response reports what would move. */
  dryRun: z.boolean(),
});

export const KnowledgeBaseProjectMergeResponseSchema = z.object({
  type: z.literal("kb.project.merge.response"),
  payload: z.object({
    requestId: z.string(),
    dryRun: z.boolean(),
    moved: KnowledgeBaseMergeCountsSchema,
    target: z.object({
      path: z.string(),
      permalink: z.string(),
      title: z.string(),
    }),
  }),
});

// --- Types ---------------------------------------------------------------------

export type KnowledgeBaseSidecarStatus = z.infer<typeof KnowledgeBaseSidecarStatusSchema>;
export type KnowledgeBaseNoteSummary = z.infer<typeof KnowledgeBaseNoteSummarySchema>;
export type KnowledgeBaseBacklink = z.infer<typeof KnowledgeBaseBacklinkSchema>;
export type KnowledgeBaseSearchResult = z.infer<typeof KnowledgeBaseSearchResultSchema>;
export type KnowledgeBaseGraphNode = z.infer<typeof KnowledgeBaseGraphNodeSchema>;
export type KnowledgeBaseGraphEdge = z.infer<typeof KnowledgeBaseGraphEdgeSchema>;
export type KnowledgeBaseMergeCounts = z.infer<typeof KnowledgeBaseMergeCountsSchema>;

export type KnowledgeBaseStatusRequest = z.infer<typeof KnowledgeBaseStatusRequestSchema>;
export type KnowledgeBaseStatusResponse = z.infer<typeof KnowledgeBaseStatusResponseSchema>;
export type KnowledgeBaseNotesListRequest = z.infer<typeof KnowledgeBaseNotesListRequestSchema>;
export type KnowledgeBaseNotesListResponse = z.infer<typeof KnowledgeBaseNotesListResponseSchema>;
export type KnowledgeBaseNoteGetRequest = z.infer<typeof KnowledgeBaseNoteGetRequestSchema>;
export type KnowledgeBaseNoteGetResponse = z.infer<typeof KnowledgeBaseNoteGetResponseSchema>;
export type KnowledgeBaseNoteWriteRequest = z.infer<typeof KnowledgeBaseNoteWriteRequestSchema>;
export type KnowledgeBaseNoteWriteResponse = z.infer<typeof KnowledgeBaseNoteWriteResponseSchema>;
export type KnowledgeBaseSearchRequest = z.infer<typeof KnowledgeBaseSearchRequestSchema>;
export type KnowledgeBaseSearchResponse = z.infer<typeof KnowledgeBaseSearchResponseSchema>;
export type KnowledgeBaseGraphGetRequest = z.infer<typeof KnowledgeBaseGraphGetRequestSchema>;
export type KnowledgeBaseGraphGetResponse = z.infer<typeof KnowledgeBaseGraphGetResponseSchema>;
export type KnowledgeBaseProjectRenameRequest = z.infer<
  typeof KnowledgeBaseProjectRenameRequestSchema
>;
export type KnowledgeBaseProjectRenameResponse = z.infer<
  typeof KnowledgeBaseProjectRenameResponseSchema
>;
export type KnowledgeBaseProjectMergeRequest = z.infer<
  typeof KnowledgeBaseProjectMergeRequestSchema
>;
export type KnowledgeBaseProjectMergeResponse = z.infer<
  typeof KnowledgeBaseProjectMergeResponseSchema
>;
