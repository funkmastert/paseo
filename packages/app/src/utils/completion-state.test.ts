import { describe, expect, it } from "vitest";
import {
  getCompletionNoteFromLabels,
  getCompletionStateFromLabels,
  resolveRowCompletionIndicator,
} from "./completion-state";
import type { SidebarStateBucket } from "./sidebar-agent-state";

describe("getCompletionStateFromLabels", () => {
  it("reads a valid completion state", () => {
    expect(getCompletionStateFromLabels({ "paseo.completion": "ready-to-merge" })).toBe(
      "ready-to-merge",
    );
    expect(getCompletionStateFromLabels({ "paseo.completion": "done" })).toBe("done");
  });

  it("returns null when the label is absent, unknown, or not a string", () => {
    expect(getCompletionStateFromLabels(null)).toBeNull();
    expect(getCompletionStateFromLabels(undefined)).toBeNull();
    expect(getCompletionStateFromLabels({})).toBeNull();
    expect(getCompletionStateFromLabels({ "paseo.completion": "archived" })).toBeNull();
    expect(getCompletionStateFromLabels({ "paseo.completion": 1 })).toBeNull();
  });
});

describe("getCompletionNoteFromLabels", () => {
  it("reads and trims the note", () => {
    expect(getCompletionNoteFromLabels({ "paseo.completion-note": "  PR #41 merged  " })).toBe(
      "PR #41 merged",
    );
  });

  it("returns null for absent, blank, or non-string notes", () => {
    expect(getCompletionNoteFromLabels(null)).toBeNull();
    expect(getCompletionNoteFromLabels({})).toBeNull();
    expect(getCompletionNoteFromLabels({ "paseo.completion-note": "   " })).toBeNull();
    expect(getCompletionNoteFromLabels({ "paseo.completion-note": 42 })).toBeNull();
  });

  it("caps the note at 200 characters", () => {
    const long = "x".repeat(250);
    const note = getCompletionNoteFromLabels({ "paseo.completion-note": long });
    expect(note).toHaveLength(200);
  });
});

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
