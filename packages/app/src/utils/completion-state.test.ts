import { describe, expect, it } from "vitest";
import { resolveRowCompletionIndicator } from "./completion-state";
import type { SidebarStateBucket } from "./sidebar-agent-state";

describe("resolveRowCompletionIndicator", () => {
  it("shows the completion state only when the bucket is done", () => {
    expect(
      resolveRowCompletionIndicator({ bucket: "done", completionState: "ready-to-merge" }),
    ).toBe("ready-to-merge");
    expect(resolveRowCompletionIndicator({ bucket: "done", completionState: "done" })).toBe("done");
    expect(resolveRowCompletionIndicator({ bucket: "done", completionState: null })).toBeNull();
  });

  it("ignores a stale completion label on any non-done bucket", () => {
    const nonDoneBuckets: SidebarStateBucket[] = ["needs_input", "failed", "running", "attention"];
    for (const bucket of nonDoneBuckets) {
      expect(resolveRowCompletionIndicator({ bucket, completionState: "done" })).toBeNull();
      expect(
        resolveRowCompletionIndicator({ bucket, completionState: "ready-to-merge" }),
      ).toBeNull();
    }
  });
});
