import { describe, expect, it } from "vitest";
import { WORK_ITEM_STATES } from "@getpaseo/protocol/coordination/queue-schemas";
import {
  QueueValidationError,
  isOpenState,
  isLegalTransition,
  validateClosure,
  validateTransition,
} from "./state-machine.js";

describe("work item state machine", () => {
  it("lets open items move between the open states and close", () => {
    expect(isLegalTransition("pending", "in-progress")).toBe(true);
    expect(isLegalTransition("in-progress", "pending")).toBe(true);
    expect(isLegalTransition("in-progress", "blocked")).toBe(true);
    expect(isLegalTransition("blocked", "in-progress")).toBe(true);
    expect(isLegalTransition("in-progress", "done")).toBe(true);
    expect(isLegalTransition("pending", "canceled")).toBe(true);
  });

  it("never moves a terminal item", () => {
    for (const from of ["done", "failed", "denied", "canceled", "handed-off"] as const) {
      expect(isOpenState(from)).toBe(false);
      for (const to of WORK_ITEM_STATES) {
        expect(isLegalTransition(from, to)).toBe(false);
      }
    }
  });

  it("rejects a no-op move", () => {
    expect(isLegalTransition("pending", "pending")).toBe(false);
  });

  it("explains a move out of a terminal state", () => {
    expect(() => validateTransition({ from: "done", to: "in-progress" })).toThrow(
      /already done.*Create a new item/s,
    );
  });

  it("sends handed-off through handoff", () => {
    expect(() =>
      validateTransition({
        from: "in-progress",
        to: "handed-off",
        closure: { reason: "handed_off_to", target: "agent-b" },
      }),
    ).toThrow(/handoff/);
  });
});

describe("closure contract", () => {
  it("requires a closure to finish as done", () => {
    expect(() => validateTransition({ from: "in-progress", to: "done" })).toThrow(
      /closure reason.*no-follow-on/s,
    );
    expect(() =>
      validateTransition({ from: "in-progress", to: "done", closure: { reason: "no-follow-on" } }),
    ).not.toThrow();
  });

  it("requires a target for reasons that name where the work went", () => {
    for (const reason of ["handed_off_to", "blocked_on", "escalation"] as const) {
      expect(() => validateClosure({ reason })).toThrow(QueueValidationError);
      expect(() => validateClosure({ reason, target: "  " })).toThrow(/target/);
      expect(() => validateClosure({ reason, target: "agent-b" })).not.toThrow();
    }
    expect(() => validateClosure({ reason: "denied" })).not.toThrow();
  });

  it("requires blocked to say what it is blocked on", () => {
    expect(() => validateTransition({ from: "in-progress", to: "blocked" })).toThrow(/blocked_on/);
    expect(() =>
      validateTransition({
        from: "in-progress",
        to: "blocked",
        closure: { reason: "canceled" },
      }),
    ).toThrow(/blocked_on/);
    expect(() =>
      validateTransition({
        from: "in-progress",
        to: "blocked",
        closure: { reason: "blocked_on", target: "item-42" },
      }),
    ).not.toThrow();
  });

  it("refuses a closure on a move that does not close", () => {
    expect(() =>
      validateTransition({
        from: "pending",
        to: "in-progress",
        closure: { reason: "no-follow-on" },
      }),
    ).toThrow(/only applies/);
  });

  it("checks a closure given with denied or canceled", () => {
    expect(() => validateTransition({ from: "pending", to: "canceled" })).not.toThrow();
    expect(() =>
      validateTransition({ from: "pending", to: "denied", closure: { reason: "escalation" } }),
    ).toThrow(/target/);
  });
});
