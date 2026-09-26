import { describe, expect, test } from "vitest";

import {
  applyServerEvent,
  createDisabledServerState,
  InvalidMcpGatewayTransitionError,
} from "./state.js";

describe("createDisabledServerState", () => {
  test("starts disabled", () => {
    const state = createDisabledServerState(1_000);
    expect(state).toEqual({ status: "disabled", lastChangedAt: 1_000 });
  });
});

describe("applyServerEvent", () => {
  test("enable moves disabled -> connecting", () => {
    const state = createDisabledServerState(0);
    const next = applyServerEvent(state, { type: "enable" }, 10);
    expect(next).toEqual({ status: "connecting", lastChangedAt: 10 });
  });

  test("connected moves connecting -> connected", () => {
    const state = applyServerEvent(createDisabledServerState(0), { type: "enable" }, 1);
    const next = applyServerEvent(state, { type: "connected" }, 2);
    expect(next).toEqual({ status: "connected", lastChangedAt: 2 });
  });

  test("needsAuth moves connecting -> needs-auth", () => {
    const state = applyServerEvent(createDisabledServerState(0), { type: "enable" }, 1);
    const next = applyServerEvent(state, { type: "needsAuth" }, 2);
    expect(next).toEqual({ status: "needs-auth", lastChangedAt: 2 });
  });

  test("connectionFailed moves connecting -> error with message", () => {
    const state = applyServerEvent(createDisabledServerState(0), { type: "enable" }, 1);
    const next = applyServerEvent(state, { type: "connectionFailed", error: "boom" }, 2);
    expect(next).toEqual({ status: "error", error: "boom", lastChangedAt: 2 });
  });

  test("refreshFailed moves connected -> needs-auth", () => {
    let state = applyServerEvent(createDisabledServerState(0), { type: "enable" }, 1);
    state = applyServerEvent(state, { type: "connected" }, 2);
    const next = applyServerEvent(state, { type: "refreshFailed" }, 3);
    expect(next).toEqual({ status: "needs-auth", lastChangedAt: 3 });
  });

  test("needsAuth moves connected -> needs-auth (mid-session revocation)", () => {
    let state = applyServerEvent(createDisabledServerState(0), { type: "enable" }, 1);
    state = applyServerEvent(state, { type: "connected" }, 2);
    const next = applyServerEvent(state, { type: "needsAuth" }, 3);
    expect(next).toEqual({ status: "needs-auth", lastChangedAt: 3 });
  });

  test("connectionFailed moves connected -> error", () => {
    let state = applyServerEvent(createDisabledServerState(0), { type: "enable" }, 1);
    state = applyServerEvent(state, { type: "connected" }, 2);
    const next = applyServerEvent(state, { type: "connectionFailed", error: "dropped" }, 3);
    expect(next).toEqual({ status: "error", error: "dropped", lastChangedAt: 3 });
  });

  test("authCompleted moves needs-auth -> connecting", () => {
    let state = applyServerEvent(createDisabledServerState(0), { type: "enable" }, 1);
    state = applyServerEvent(state, { type: "needsAuth" }, 2);
    const next = applyServerEvent(state, { type: "authCompleted" }, 3);
    expect(next).toEqual({ status: "connecting", lastChangedAt: 3 });
  });

  test("retry moves error -> connecting", () => {
    let state = applyServerEvent(createDisabledServerState(0), { type: "enable" }, 1);
    state = applyServerEvent(state, { type: "connectionFailed", error: "boom" }, 2);
    const next = applyServerEvent(state, { type: "retry" }, 3);
    expect(next).toEqual({ status: "connecting", lastChangedAt: 3 });
  });

  test("disable moves any status back to disabled", () => {
    let state = applyServerEvent(createDisabledServerState(0), { type: "enable" }, 1);
    state = applyServerEvent(state, { type: "connected" }, 2);
    const next = applyServerEvent(state, { type: "disable" }, 3);
    expect(next).toEqual({ status: "disabled", lastChangedAt: 3 });
  });

  test("disable is a no-op (same reference-equal timestamp) when already disabled", () => {
    const state = createDisabledServerState(0);
    const next = applyServerEvent(state, { type: "disable" }, 99);
    expect(next).toBe(state);
  });

  test("throws on an illegal transition instead of silently accepting it", () => {
    const state = createDisabledServerState(0);
    expect(() => applyServerEvent(state, { type: "connected" }, 1)).toThrow(
      InvalidMcpGatewayTransitionError,
    );
  });

  test("throws retrying a server that isn't in error", () => {
    const state = createDisabledServerState(0);
    expect(() => applyServerEvent(state, { type: "retry" }, 1)).toThrow(
      InvalidMcpGatewayTransitionError,
    );
  });
});
