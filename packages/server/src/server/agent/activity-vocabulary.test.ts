import { describe, expect, test } from "vitest";
import {
  computeNeedsInput,
  computeResumability,
  type NeedsInputInput,
} from "./activity-vocabulary.js";

function needsInputInput(overrides: Partial<NeedsInputInput> = {}): NeedsInputInput {
  return {
    pendingPermissionKinds: [],
    status: "idle",
    lastError: undefined,
    spendPaused: false,
    ...overrides,
  };
}

describe("computeNeedsInput", () => {
  test("an agent simply working carries nothing", () => {
    expect(computeNeedsInput(needsInputInput())).toBeUndefined();
  });

  test("a pending tool permission is the 'permission' reason", () => {
    expect(computeNeedsInput(needsInputInput({ pendingPermissionKinds: ["tool"] }))).toEqual({
      count: 1,
      reasons: ["permission"],
    });
  });

  test("a pending mode/plan/other permission also reads as 'permission'", () => {
    expect(
      computeNeedsInput(needsInputInput({ pendingPermissionKinds: ["plan", "mode", "other"] })),
    ).toEqual({ count: 3, reasons: ["permission"] });
  });

  test("a pending question permission is the 'question' reason, distinct from 'permission'", () => {
    expect(computeNeedsInput(needsInputInput({ pendingPermissionKinds: ["question"] }))).toEqual({
      count: 1,
      reasons: ["question"],
    });
  });

  test("a limit-shaped error while the agent is in error status is the 'usage_limit' reason", () => {
    expect(
      computeNeedsInput(
        needsInputInput({ status: "error", lastError: "You've hit your usage limit" }),
      ),
    ).toEqual({ count: 1, reasons: ["usage_limit"] });
  });

  test("a non-limit-shaped error is not needs-input", () => {
    expect(
      computeNeedsInput(needsInputInput({ status: "error", lastError: "ECONNRESET" })),
    ).toBeUndefined();
  });

  test("a limit-shaped lastError on a non-error status is not needs-input", () => {
    // Stale `lastError` can outlive the turn that produced it; only a live error status counts.
    expect(
      computeNeedsInput(needsInputInput({ status: "idle", lastError: "usage limit" })),
    ).toBeUndefined();
  });

  test("a fired spend-governor pause is the 'spend_paused' reason", () => {
    expect(computeNeedsInput(needsInputInput({ spendPaused: true }))).toEqual({
      count: 1,
      reasons: ["spend_paused"],
    });
  });

  test("count sums distinct conditions; reasons de-duplicate by kind", () => {
    expect(
      computeNeedsInput(
        needsInputInput({
          pendingPermissionKinds: ["tool", "question", "question"],
          status: "error",
          lastError: "rate limit exceeded",
          spendPaused: true,
        }),
      ),
    ).toEqual({
      count: 5,
      reasons: expect.arrayContaining(["permission", "question", "usage_limit", "spend_paused"]),
    });
  });
});

describe("computeResumability", () => {
  test("a resident runtime is 'live', regardless of persistence", () => {
    expect(computeResumability({ isLive: true, hasPersistenceHandle: false })).toBe("live");
    expect(computeResumability({ isLive: true, hasPersistenceHandle: true })).toBe("live");
  });

  test("closed with no persistence handle is 'unreachable'", () => {
    expect(computeResumability({ isLive: false, hasPersistenceHandle: false })).toBe("unreachable");
  });

  test("closed with a persistence handle and a confirmed-available provider is 'resumable'", () => {
    expect(
      computeResumability({ isLive: false, hasPersistenceHandle: true, providerAvailable: true }),
    ).toBe("resumable");
  });

  test("closed with a persistence handle and a confirmed-unavailable provider is 'unreachable'", () => {
    expect(
      computeResumability({ isLive: false, hasPersistenceHandle: true, providerAvailable: false }),
    ).toBe("unreachable");
  });

  test("closed with a persistence handle and no cheap provider-availability answer is 'unknown'", () => {
    expect(computeResumability({ isLive: false, hasPersistenceHandle: true })).toBe("unknown");
  });
});
