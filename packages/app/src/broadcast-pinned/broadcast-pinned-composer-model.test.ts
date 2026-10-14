import { describe, expect, it } from "vitest";
import { createBroadcastPinnedComposerModel } from "./broadcast-pinned-composer-model";
import type { BroadcastPinnedTarget } from "./broadcast-pinned-targets";

function target(id: string): BroadcastPinnedTarget {
  return {
    id,
    serverId: "host-1",
    workspaceId: "ws-1",
    workspaceName: "Chat",
    label: id,
    agentTitle: null,
    status: "idle",
  };
}

describe("createBroadcastPinnedComposerModel", () => {
  it("starts with every target checked", () => {
    const model = createBroadcastPinnedComposerModel([target("a1"), target("a2")]);
    const snapshot = model.snapshot();
    expect(snapshot.checked.has("a1")).toBe(true);
    expect(snapshot.checked.has("a2")).toBe(true);
    expect(snapshot.text).toBe("");
  });

  it("cannot send with empty text regardless of checked targets", () => {
    const model = createBroadcastPinnedComposerModel([target("a1")]);
    expect(model.snapshot().canSend).toBe(false);
  });

  it("cannot send with text but zero checked targets", () => {
    const model = createBroadcastPinnedComposerModel([target("a1")]);
    model.setText("go");
    model.toggleTarget("a1");
    expect(model.snapshot().checked.size).toBe(0);
    expect(model.snapshot().canSend).toBe(false);
  });

  it("can send once text is non-empty and at least one target stays checked", () => {
    const model = createBroadcastPinnedComposerModel([target("a1"), target("a2")]);
    model.setText("go");
    model.toggleTarget("a2");
    expect(model.snapshot().canSend).toBe(true);
    expect(model.snapshot().checked.has("a1")).toBe(true);
    expect(model.snapshot().checked.has("a2")).toBe(false);
  });

  it("toggling a target twice restores its original checked state without affecting others", () => {
    const model = createBroadcastPinnedComposerModel([target("a1"), target("a2")]);
    model.toggleTarget("a1");
    model.toggleTarget("a1");
    expect(model.snapshot().checked.has("a1")).toBe(true);
    expect(model.snapshot().checked.has("a2")).toBe(true);
  });

  it("whitespace-only text cannot send", () => {
    const model = createBroadcastPinnedComposerModel([target("a1")]);
    model.setText("   ");
    expect(model.snapshot().canSend).toBe(false);
  });
});
