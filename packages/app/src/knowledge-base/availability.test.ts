import { describe, expect, it } from "vitest";
import type { KnowledgeBaseSidecarStatus } from "@getpaseo/protocol/knowledge-base/rpc-schemas";
import {
  KNOWLEDGE_BASE_SETUP_COMMAND,
  resolveKnowledgeBaseAvailability,
  type KnowledgeBaseStatusState,
} from "./availability";

const RUNNING: KnowledgeBaseSidecarStatus = {
  state: "running",
  since: 1,
  pid: 42,
  version: "0.23.2",
  stderrTail: [],
};

function loaded(sidecar: KnowledgeBaseSidecarStatus, enabled = true): KnowledgeBaseStatusState {
  return { kind: "loaded", status: { enabled, sidecar, setupHint: null } };
}

function resolve(status: KnowledgeBaseStatusState, overrides: Partial<{ supports: boolean }> = {}) {
  return resolveKnowledgeBaseAvailability({
    hasHost: true,
    connected: true,
    supportsKnowledgeBase: overrides.supports ?? true,
    status,
  });
}

describe("resolveKnowledgeBaseAvailability", () => {
  it("asks for a host when none is paired", () => {
    expect(
      resolveKnowledgeBaseAvailability({
        hasHost: false,
        connected: false,
        supportsKnowledgeBase: false,
        status: { kind: "loading" },
      }),
    ).toEqual({ kind: "no-host" });
  });

  it("waits for the host to connect before reading its feature flags", () => {
    expect(
      resolveKnowledgeBaseAvailability({
        hasHost: true,
        connected: false,
        supportsKnowledgeBase: false,
        status: { kind: "loading" },
      }),
    ).toEqual({ kind: "connecting" });
  });

  it("asks to update the host when the knowledgeBase feature flag is absent", () => {
    expect(resolve({ kind: "loading" }, { supports: false })).toEqual({ kind: "update-host" });
  });

  it("waits on kb.status, then shows its error with a retry", () => {
    expect(resolve({ kind: "loading" })).toEqual({ kind: "status-loading" });
    expect(resolve({ kind: "error", message: "socket closed" })).toEqual({
      kind: "status-error",
      message: "socket closed",
    });
  });

  it("explains how to turn the feature on when kb.status reports it disabled", () => {
    expect(
      resolve({
        kind: "loaded",
        status: {
          enabled: false,
          sidecar: { state: "disabled" },
          setupHint: "Add a knowledgeBase section to config.json and reload.",
        },
      }),
    ).toEqual({
      kind: "disabled",
      setupHint: "Add a knowledgeBase section to config.json and reload.",
      setupCommand: KNOWLEDGE_BASE_SETUP_COMMAND,
    });
  });

  it("shows the list with full-text search and no banner while the sidecar runs", () => {
    expect(resolve(loaded(RUNNING))).toEqual({
      kind: "ready",
      banner: null,
      fullTextSearch: true,
    });
  });

  it("shows the list plus a banner with the hint and setup command when the sidecar is missing", () => {
    expect(
      resolve(
        loaded({ state: "missing", command: "basic-memory", hint: "basic-memory is not on PATH" }),
      ),
    ).toEqual({
      kind: "ready",
      banner: {
        state: "missing",
        detail: "basic-memory is not on PATH",
        setupCommand: KNOWLEDGE_BASE_SETUP_COMMAND,
      },
      fullTextSearch: false,
    });
  });

  it("shows the list plus a starting banner while the sidecar starts", () => {
    expect(resolve(loaded({ state: "starting", since: 5 }))).toEqual({
      kind: "ready",
      banner: { state: "starting", detail: null, setupCommand: null },
      fullTextSearch: false,
    });
  });

  it("shows the list plus a backoff banner with the last stderr line", () => {
    expect(
      resolve(
        loaded({
          state: "backoff",
          error: "exited with code 1",
          stderrTail: ["Traceback (most recent call last):", "ModuleNotFoundError: mcp"],
          attempt: 2,
          delayMs: 4000,
          retryAt: 10,
        }),
      ),
    ).toEqual({
      kind: "ready",
      banner: { state: "backoff", detail: "ModuleNotFoundError: mcp", setupCommand: null },
      fullTextSearch: false,
    });
  });

  it("falls back to the backoff error when the sidecar wrote nothing to stderr", () => {
    expect(
      resolve(
        loaded({
          state: "backoff",
          error: "MCP initialize timed out",
          stderrTail: [],
          attempt: 1,
          delayMs: 2000,
          retryAt: 10,
        }),
      ),
    ).toEqual({
      kind: "ready",
      banner: { state: "backoff", detail: "MCP initialize timed out", setupCommand: null },
      fullTextSearch: false,
    });
  });

  it("keeps the list without a banner but without full-text search when the sidecar reports disabled", () => {
    expect(resolve(loaded({ state: "disabled" }))).toEqual({
      kind: "ready",
      banner: null,
      fullTextSearch: false,
    });
  });
});
