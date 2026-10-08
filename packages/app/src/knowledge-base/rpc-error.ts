/**
 * The `kb.*` RPCs answer failures as `rpc_error` with a code (`disabled`, `not_found`, `conflict`,
 * `search_unavailable`, `invalid_request`); the client surfaces it as an error carrying `code`.
 * `invalid_request` is U9's: the knowledge base service rejects an empty rename title or a merge
 * of a project into itself this way (knowledge-base-session.ts `INVALID_REQUEST_ERROR_NAME`).
 */
export type KnowledgeBaseErrorCode =
  | "disabled"
  | "not_found"
  | "conflict"
  | "search_unavailable"
  | "invalid_request";

export function knowledgeBaseErrorCode(error: unknown): string | null {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return null;
}

export function isKnowledgeBaseError(error: unknown, code: KnowledgeBaseErrorCode): boolean {
  return knowledgeBaseErrorCode(error) === code;
}

/** The daemon's own sentence, without the ` requestType=… code=…` the client appends. */
export function knowledgeBaseErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const correlation = message.indexOf(" requestType=");
  return correlation === -1 ? message : message.slice(0, correlation);
}
