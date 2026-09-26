import { describe, expect, it } from "vitest";
import { resolveOrchestrationFreshness } from "./orchestration-panel-model";

describe("resolveOrchestrationFreshness", () => {
  it("is live only when the host is online and its directory is settled", () => {
    expect(
      resolveOrchestrationFreshness({ connectionStatus: "online", directoryStatus: "ready" }),
    ).toEqual({ kind: "live" });
  });

  it("is stale when the host is not reachable, however good the last sync was", () => {
    for (const connectionStatus of ["offline", "error", "idle"] as const) {
      expect(resolveOrchestrationFreshness({ connectionStatus, directoryStatus: "ready" })).toEqual(
        { kind: "stale" },
      );
    }
  });

  it("is stale when a refresh failed after a good one — the socket is up but nothing retries", () => {
    expect(
      resolveOrchestrationFreshness({
        connectionStatus: "online",
        directoryStatus: "error_after_ready",
      }),
    ).toEqual({ kind: "stale" });
  });

  it("stays quiet while a sync is in flight rather than calling it stale", () => {
    expect(
      resolveOrchestrationFreshness({ connectionStatus: "connecting", directoryStatus: "ready" }),
    ).toEqual({ kind: "syncing" });
    expect(
      resolveOrchestrationFreshness({
        connectionStatus: "online",
        directoryStatus: "revalidating",
      }),
    ).toEqual({ kind: "syncing" });
  });
});
