import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  KnowledgeBaseGraphEdge,
  KnowledgeBaseGraphNode,
  KnowledgeBaseMergeCounts,
  KnowledgeBaseNoteGetResponse,
  KnowledgeBaseNoteSummary,
  KnowledgeBaseSearchResult,
} from "@getpaseo/protocol/knowledge-base/rpc-schemas";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { KnowledgeBaseStatusState } from "./availability";
import type { KnowledgeSearchState } from "./knowledge-list-model";
import type { KnowledgeNoteEditorBackend, KnowledgeNoteRead } from "./note-editor-model";
import {
  isKnowledgeBaseError,
  knowledgeBaseErrorCode,
  knowledgeBaseErrorMessage,
} from "./rpc-error";

/**
 * The view refetches on focus (the screen unmounts while unfocused, and fetch queries refetch on
 * mount), after its own writes, and on these intervals while open. Live push is follow-up work.
 */
export const KNOWLEDGE_BASE_STATUS_POLL_MS = 15 * 1000;
export const KNOWLEDGE_BASE_LIST_POLL_MS = 30 * 1000;
export const KNOWLEDGE_BASE_NOTE_POLL_MS = 10 * 1000;

export type KnowledgeBaseNote = Omit<KnowledgeBaseNoteGetResponse["payload"], "requestId">;

export type KnowledgeNoteResult =
  | { status: "ready"; note: KnowledgeBaseNote }
  | { status: "missing" };

export type KnowledgeNotesLoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; notes: readonly KnowledgeBaseNoteSummary[] };

export interface KnowledgeGraphData {
  nodes: readonly KnowledgeBaseGraphNode[];
  edges: readonly KnowledgeBaseGraphEdge[];
}

export type KnowledgeGraphLoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; graph: KnowledgeGraphData };

export type KnowledgeNoteLoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; result: KnowledgeNoteResult };

function knowledgeBaseQueryKey(serverId: string | null, ...parts: string[]) {
  return ["knowledgeBase", serverId ?? "", ...parts] as const;
}

export interface KnowledgeBaseHost {
  connected: boolean;
  supported: boolean;
}

/** Gates every `kb.*` call but `kb.status` on `server_info.features.knowledgeBase` (KTD-12). */
export function useKnowledgeBaseHost(serverId: string | null): KnowledgeBaseHost {
  const connected = useHostRuntimeIsConnected(serverId ?? "");
  const supported = useHostFeature(serverId, "knowledgeBase");
  return { connected, supported };
}

function useKnowledgeBaseClient(serverId: string | null) {
  return useHostRuntimeClient(serverId ?? "");
}

function requireClient<T>(client: T | null): T {
  // Unreachable in practice: every query below is enabled only while a client exists.
  if (!client) throw new Error("knowledge base requested without a host client");
  return client;
}

export function useKnowledgeBaseStatus(
  serverId: string | null,
  enabled: boolean,
): { state: KnowledgeBaseStatusState; refetch: () => void } {
  const client = useKnowledgeBaseClient(serverId);
  const queryFn = useCallback(async () => requireClient(client).getKnowledgeBaseStatus(), [client]);
  const query = useFetchQuery({
    queryKey: knowledgeBaseQueryKey(serverId, "status"),
    dataShape: "value",
    staleTimeMs: KNOWLEDGE_BASE_STATUS_POLL_MS,
    queryFn,
    enabled: enabled && Boolean(client),
    refetchInterval: KNOWLEDGE_BASE_STATUS_POLL_MS,
  });
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);

  let state: KnowledgeBaseStatusState = { kind: "loading" };
  if (query.data) {
    const { enabled: isEnabled, sidecar, setupHint } = query.data;
    state = { kind: "loaded", status: { enabled: isEnabled, sidecar, setupHint } };
  } else if (query.error) {
    state = { kind: "error", message: knowledgeBaseErrorMessage(query.error) };
  }
  return { state, refetch: retry };
}

export function useKnowledgeBaseNotes(
  serverId: string | null,
  enabled: boolean,
): { state: KnowledgeNotesLoadState; refetch: () => void } {
  const client = useKnowledgeBaseClient(serverId);
  const queryFn = useCallback(
    async () => (await requireClient(client).listKnowledgeBaseNotes()).notes,
    [client],
  );
  const query = useFetchQuery({
    queryKey: knowledgeBaseQueryKey(serverId, "notes"),
    dataShape: "list",
    staleTimeMs: KNOWLEDGE_BASE_LIST_POLL_MS,
    queryFn,
    enabled: enabled && Boolean(client),
    refetchInterval: KNOWLEDGE_BASE_LIST_POLL_MS,
  });
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);

  let state: KnowledgeNotesLoadState = { kind: "loading" };
  if (query.data) state = { kind: "loaded", notes: query.data };
  else if (query.error) state = { kind: "error", message: knowledgeBaseErrorMessage(query.error) };
  return { state, refetch: retry };
}

/** The graph (U9, KTD-11): every note, for the Graph view. Polls like the list. */
export function useKnowledgeBaseGraph(
  serverId: string | null,
  enabled: boolean,
): { state: KnowledgeGraphLoadState; refetch: () => void } {
  const client = useKnowledgeBaseClient(serverId);
  const queryFn = useCallback(async (): Promise<KnowledgeGraphData> => {
    const graph = await requireClient(client).getKnowledgeBaseGraph();
    return { nodes: graph.nodes, edges: graph.edges };
  }, [client]);
  const query = useFetchQuery({
    queryKey: knowledgeBaseQueryKey(serverId, "graph"),
    dataShape: "value",
    staleTimeMs: KNOWLEDGE_BASE_LIST_POLL_MS,
    queryFn,
    enabled: enabled && Boolean(client),
    refetchInterval: KNOWLEDGE_BASE_LIST_POLL_MS,
  });
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);

  let state: KnowledgeGraphLoadState = { kind: "loading" };
  if (query.data) state = { kind: "loaded", graph: query.data };
  else if (query.error) state = { kind: "error", message: knowledgeBaseErrorMessage(query.error) };
  return { state, refetch: retry };
}

export interface KnowledgeBaseProjectActions {
  rename(input: { path: string; title: string }): Promise<{
    path: string;
    permalink: string;
    title: string;
  }>;
  mergeDryRun(input: {
    sourcePath: string;
    targetPath: string;
  }): Promise<{ moved: KnowledgeBaseMergeCounts }>;
  merge(input: { sourcePath: string; targetPath: string }): Promise<{
    target: { path: string; permalink: string; title: string };
  }>;
}

/** Rename and merge (U9, KTD-11): invalidates the note list and every note touched. */
export function useKnowledgeBaseProjectActions(
  serverId: string | null,
): KnowledgeBaseProjectActions {
  const client = useKnowledgeBaseClient(serverId);
  const queryClient = useQueryClient();
  const invalidateNote = useCallback(
    (path: string) =>
      queryClient.invalidateQueries({ queryKey: knowledgeBaseQueryKey(serverId, "note", path) }),
    [queryClient, serverId],
  );
  const invalidateLists = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: knowledgeBaseQueryKey(serverId, "notes") });
    void queryClient.invalidateQueries({ queryKey: knowledgeBaseQueryKey(serverId, "graph") });
  }, [queryClient, serverId]);
  return useMemo<KnowledgeBaseProjectActions>(
    () => ({
      async rename(input) {
        const result = await requireClient(client).renameKnowledgeBaseProject(input);
        invalidateLists();
        void invalidateNote(input.path);
        return result;
      },
      async mergeDryRun(input) {
        const result = await requireClient(client).mergeKnowledgeBaseProjects({
          ...input,
          dryRun: true,
        });
        return { moved: result.moved };
      },
      async merge(input) {
        const result = await requireClient(client).mergeKnowledgeBaseProjects({
          ...input,
          dryRun: false,
        });
        invalidateLists();
        void invalidateNote(input.sourcePath);
        void invalidateNote(input.targetPath);
        return { target: result.target };
      },
    }),
    [client, invalidateLists, invalidateNote],
  );
}

async function readNote(
  client: NonNullable<ReturnType<typeof useHostRuntimeClient>>,
  path: string,
): Promise<KnowledgeNoteResult> {
  try {
    const { requestId: _requestId, ...note } = await client.getKnowledgeBaseNote(path);
    return { status: "ready", note };
  } catch (error) {
    if (isKnowledgeBaseError(error, "not_found")) return { status: "missing" };
    throw error;
  }
}

export function useKnowledgeBaseNote(
  serverId: string | null,
  path: string | null,
  enabled: boolean,
): { state: KnowledgeNoteLoadState; refetch: () => void } {
  const client = useKnowledgeBaseClient(serverId);
  const queryFn = useCallback(
    async () => readNote(requireClient(client), path ?? ""),
    [client, path],
  );
  const query = useFetchQuery({
    queryKey: knowledgeBaseQueryKey(serverId, "note", path ?? ""),
    dataShape: "value",
    staleTimeMs: KNOWLEDGE_BASE_NOTE_POLL_MS,
    queryFn,
    enabled: enabled && Boolean(client) && path !== null,
    refetchInterval: KNOWLEDGE_BASE_NOTE_POLL_MS,
  });
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);

  let state: KnowledgeNoteLoadState = { kind: "loading" };
  if (query.data) state = { kind: "loaded", result: query.data };
  else if (query.error) state = { kind: "error", message: knowledgeBaseErrorMessage(query.error) };
  return { state, refetch: retry };
}

export function useKnowledgeBaseSearch(
  serverId: string | null,
  query: string,
  enabled: boolean,
): KnowledgeSearchState {
  const client = useKnowledgeBaseClient(serverId);
  const trimmed = query.trim();
  const queryFn = useCallback(
    async (): Promise<readonly KnowledgeBaseSearchResult[]> =>
      (await requireClient(client).searchKnowledgeBase(trimmed)).results,
    [client, trimmed],
  );
  const search = useFetchQuery({
    queryKey: knowledgeBaseQueryKey(serverId, "search", trimmed),
    dataShape: "value",
    staleTimeMs: KNOWLEDGE_BASE_LIST_POLL_MS,
    queryFn,
    enabled: enabled && Boolean(client) && trimmed.length > 0,
    retry: false,
  });
  if (search.data) return { kind: "loaded", results: search.data };
  if (search.error) {
    return {
      kind: "error",
      code: knowledgeBaseErrorCode(search.error),
      message: knowledgeBaseErrorMessage(search.error),
    };
  }
  return { kind: "pending" };
}

/**
 * The editor's daemon side. A successful write refreshes the note list (titles and counts may
 * have changed) and the open note (its links and backlinks come from the daemon's scan).
 */
export function useKnowledgeNoteEditorBackend(serverId: string | null): KnowledgeNoteEditorBackend {
  const client = useKnowledgeBaseClient(serverId);
  const queryClient = useQueryClient();
  return useMemo<KnowledgeNoteEditorBackend>(
    () => ({
      async write(input) {
        const written = await requireClient(client).writeKnowledgeBaseNote(input);
        void queryClient.invalidateQueries({ queryKey: knowledgeBaseQueryKey(serverId, "notes") });
        void queryClient.invalidateQueries({
          queryKey: knowledgeBaseQueryKey(serverId, "note", input.path),
        });
        return {
          content: written.content,
          modifiedAt: written.modifiedAt,
          removedSecretSpans: written.removedSecretSpans,
        };
      },
      async read(path): Promise<KnowledgeNoteRead> {
        const result = await readNote(requireClient(client), path);
        if (result.status === "missing") return result;
        return {
          status: "ready",
          content: result.note.content,
          modifiedAt: result.note.modifiedAt,
        };
      },
    }),
    [client, queryClient, serverId],
  );
}
