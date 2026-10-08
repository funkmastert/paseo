import { describe, expect, it } from "vitest";
import type { KnowledgeBaseMergeCounts } from "@getpaseo/protocol/knowledge-base/rpc-schemas";
import { openMergeProjectForm, type MergeProjectCandidate } from "./merge-project-form-model";

const source: MergeProjectCandidate = {
  path: "projects/checkout-redesign.md",
  permalink: "checkout-redesign",
  title: "Checkout redesign",
};
const target: MergeProjectCandidate = {
  path: "projects/on-site-recording.md",
  permalink: "on-site-recording",
  title: "On-site recording",
};
const counts: KnowledgeBaseMergeCounts = {
  links: 3,
  decisions: 2,
  rules: 1,
  agents: 0,
  workspaces: 1,
};

function form(candidates: readonly MergeProjectCandidate[] = [target]) {
  return openMergeProjectForm({ source, candidates });
}

describe("MergeProjectForm", () => {
  it("starts on the pick step with confirm disabled", () => {
    const f = form();
    expect(f.getState().step).toEqual({ kind: "pick" });
    expect(f.getState().canConfirm).toBe(false);
  });

  it("refuses merging a project into itself", () => {
    const f = form();
    f.pickTarget(source);
    expect(f.getState().step).toEqual({ kind: "pick" });
  });

  it("moves to counting then ready once the dry run resolves, enabling confirm", () => {
    const f = form();
    f.pickTarget(target);
    expect(f.getState().step).toEqual({ kind: "counting", target });
    expect(f.getState().canConfirm).toBe(false);

    f.receiveDryRun(counts);
    expect(f.getState().step).toEqual({ kind: "ready", target, counts });
    expect(f.getState().canConfirm).toBe(true);
  });

  it("shows the dry-run counts before enabling confirm, never after", () => {
    const f = form();
    f.pickTarget(target);
    f.receiveDryRunError("Unable to check the merge");
    expect(f.getState().step).toEqual({
      kind: "error",
      target,
      message: "Unable to check the merge",
    });
    expect(f.getState().canConfirm).toBe(false);
  });

  it("back returns from any step to pick", () => {
    const f = form();
    f.pickTarget(target);
    f.receiveDryRun(counts);
    f.back();
    expect(f.getState().step).toEqual({ kind: "pick" });
  });

  it("tracks the merge itself and surfaces a failure without discarding the counts", () => {
    const f = form();
    f.pickTarget(target);
    f.receiveDryRun(counts);
    f.startMerging();
    expect(f.getState().step).toEqual({ kind: "merging", target, counts });

    f.receiveMergeError("Unable to merge");
    expect(f.getState().step).toEqual({
      kind: "mergeFailed",
      target,
      counts,
      message: "Unable to merge",
    });
  });
});
