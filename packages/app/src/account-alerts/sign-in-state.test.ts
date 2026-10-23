import { describe, expect, it } from "vitest";
import { SIGN_IN_IDLE, signInReducer, type SignInState } from "./sign-in-state";

const pending: SignInState = { status: "pending" };

describe("signInReducer", () => {
  it("goes pending on start", () => {
    expect(signInReducer(SIGN_IN_IDLE, { type: "start" })).toEqual({ status: "pending" });
  });

  it("ignores a second start while pending", () => {
    expect(signInReducer(pending, { type: "start" })).toBe(pending);
  });

  it("stores the daemon's error when it refuses the login", () => {
    expect(signInReducer(pending, { type: "failed", error: "No claude binary found" })).toEqual({
      status: "failed",
      message: "No claude binary found",
    });
  });

  it("stores no message when the daemon refuses without one", () => {
    expect(signInReducer(pending, { type: "failed", error: null })).toEqual({
      status: "failed",
      message: null,
    });
  });

  it("stores a thrown error's message", () => {
    expect(signInReducer(pending, { type: "threw", error: new Error("Socket closed") })).toEqual({
      status: "failed",
      message: "Socket closed",
    });
  });

  it("stores no message for a thrown value that is not an Error", () => {
    expect(signInReducer(pending, { type: "threw", error: "boom" })).toEqual({
      status: "failed",
      message: null,
    });
  });

  it("stays pending once the daemon starts the login, until the timeout", () => {
    const started = signInReducer(pending, { type: "started" });
    expect(started).toBe(pending);
    expect(signInReducer(started, { type: "start" })).toBe(pending);

    expect(signInReducer(started, { type: "timed_out" })).toEqual({ status: "idle" });
  });

  it("leaves a failure on screen when a stale timeout fires", () => {
    const failed: SignInState = { status: "failed", message: "Socket closed" };
    expect(signInReducer(failed, { type: "timed_out" })).toBe(failed);
  });

  it("clears the last failure on a retry", () => {
    const failed: SignInState = { status: "failed", message: "Socket closed" };
    expect(signInReducer(failed, { type: "start" })).toEqual({ status: "pending" });
  });
});
