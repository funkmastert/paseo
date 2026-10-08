import type {
  KnowledgeBaseSidecarStatus,
  KnowledgeBaseStatusResponse,
} from "@getpaseo/protocol/knowledge-base/rpc-schemas";

/** Printed, never run: the daemon never installs software (KTD-4). */
export const KNOWLEDGE_BASE_SETUP_COMMAND = "paseo kb setup";

export type KnowledgeBaseStatus = Omit<KnowledgeBaseStatusResponse["payload"], "requestId">;

export type KnowledgeBaseStatusState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; status: KnowledgeBaseStatus };

export interface KnowledgeBaseSidecarBanner {
  state: "missing" | "starting" | "backoff";
  /** The missing binary's hint, or the last stderr line before a restart. */
  detail: string | null;
  /** Only when the binary is missing: installing it is the fix. */
  setupCommand: string | null;
}

/**
 * What the Knowledge screen shows, row by row of the plan's states table (U8). Reading and
 * editing do not depend on the Basic Memory sidecar, so every enabled state is `ready`; the
 * sidecar only decides the banner and whether search is full-text or a title filter.
 */
export type KnowledgeBaseAvailability =
  | { kind: "no-host" }
  | { kind: "connecting" }
  | { kind: "update-host" }
  | { kind: "status-loading" }
  | { kind: "status-error"; message: string }
  | { kind: "disabled"; setupHint: string | null; setupCommand: string }
  | { kind: "ready"; banner: KnowledgeBaseSidecarBanner | null; fullTextSearch: boolean };

export interface KnowledgeBaseAvailabilityInput {
  hasHost: boolean;
  connected: boolean;
  supportsKnowledgeBase: boolean;
  status: KnowledgeBaseStatusState;
}

export function resolveKnowledgeBaseAvailability(
  input: KnowledgeBaseAvailabilityInput,
): KnowledgeBaseAvailability {
  if (!input.hasHost) return { kind: "no-host" };
  if (!input.connected) return { kind: "connecting" };
  if (!input.supportsKnowledgeBase) return { kind: "update-host" };
  if (input.status.kind === "loading") return { kind: "status-loading" };
  if (input.status.kind === "error") {
    return { kind: "status-error", message: input.status.message };
  }
  const { status } = input.status;
  if (!status.enabled) {
    return {
      kind: "disabled",
      setupHint: status.setupHint,
      setupCommand: KNOWLEDGE_BASE_SETUP_COMMAND,
    };
  }
  return {
    kind: "ready",
    banner: sidecarBanner(status.sidecar),
    fullTextSearch: status.sidecar.state === "running",
  };
}

function sidecarBanner(sidecar: KnowledgeBaseSidecarStatus): KnowledgeBaseSidecarBanner | null {
  switch (sidecar.state) {
    case "running":
    case "disabled":
      return null;
    case "missing":
      return {
        state: "missing",
        detail: sidecar.hint,
        setupCommand: KNOWLEDGE_BASE_SETUP_COMMAND,
      };
    case "starting":
      return { state: "starting", detail: null, setupCommand: null };
    case "backoff":
      return {
        state: "backoff",
        detail: sidecar.stderrTail.at(-1) ?? sidecar.error,
        setupCommand: null,
      };
  }
}
