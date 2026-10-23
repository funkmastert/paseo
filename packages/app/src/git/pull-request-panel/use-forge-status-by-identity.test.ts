import { describe, expect, it } from "vitest";
import {
  isUnsupportedForgeStatusError,
  nextStatusRefetchInterval,
} from "./use-forge-status-by-identity";

const STATUS_REFETCH_INTERVAL_MS = 60_000;

function unknownSchemaError(requestType: string): Error {
  const error = new Error("unknown schema") as Error & { code: string; requestType: string };
  error.code = "unknown_schema";
  error.requestType = requestType;
  return error;
}

describe("isUnsupportedForgeStatusError", () => {
  it("is true for the daemon's typed unsupported_forge error", () => {
    expect(
      isUnsupportedForgeStatusError({ payloadErrorKind: "unsupported_forge", queryError: null }),
    ).toBe(true);
  });

  it("is true for an old daemon's unknown_schema error on this specific request type", () => {
    const error = unknownSchemaError("checkout.forge.get_pull_request_status.request");
    expect(isUnsupportedForgeStatusError({ payloadErrorKind: null, queryError: error })).toBe(true);
  });

  it("is false for unknown_schema from an unrelated in-flight request", () => {
    const error = unknownSchemaError("pull_request_timeline_request");
    expect(isUnsupportedForgeStatusError({ payloadErrorKind: null, queryError: error })).toBe(
      false,
    );
  });

  it("is false for a not_found error", () => {
    expect(isUnsupportedForgeStatusError({ payloadErrorKind: "not_found", queryError: null })).toBe(
      false,
    );
  });

  it("is false when there is no error at all", () => {
    expect(isUnsupportedForgeStatusError({ payloadErrorKind: null, queryError: null })).toBe(false);
  });
});

describe("nextStatusRefetchInterval", () => {
  it("polls at the fixed cadence for an open PR while enabled", () => {
    expect(
      nextStatusRefetchInterval({
        queryEnabled: true,
        status: { isMerged: false, state: "open" },
        unsupportedForge: false,
      }),
    ).toBe(STATUS_REFETCH_INTERVAL_MS);
  });

  it("stops polling once a PR is merged", () => {
    expect(
      nextStatusRefetchInterval({
        queryEnabled: true,
        status: { isMerged: true, state: "open" },
        unsupportedForge: false,
      }),
    ).toBe(false);
  });

  it("stops polling once a PR's state is no longer open", () => {
    expect(
      nextStatusRefetchInterval({
        queryEnabled: true,
        status: { isMerged: false, state: "closed" },
        unsupportedForge: false,
      }),
    ).toBe(false);
  });

  it("stops polling for an unsupported forge", () => {
    expect(
      nextStatusRefetchInterval({
        queryEnabled: true,
        status: null,
        unsupportedForge: true,
      }),
    ).toBe(false);
  });

  it("stops polling when the query is disabled (hidden row/tab)", () => {
    expect(
      nextStatusRefetchInterval({
        queryEnabled: false,
        status: { isMerged: false, state: "open" },
        unsupportedForge: false,
      }),
    ).toBe(false);
  });

  it("keeps polling at the fixed cadence before the first status arrives", () => {
    expect(
      nextStatusRefetchInterval({ queryEnabled: true, status: null, unsupportedForge: false }),
    ).toBe(STATUS_REFETCH_INTERVAL_MS);
  });

  it("stops polling on a not_found payload error -- the identity will never resolve", () => {
    expect(
      nextStatusRefetchInterval({
        queryEnabled: true,
        status: null,
        unsupportedForge: false,
        payloadErrorKind: "not_found",
      }),
    ).toBe(false);
  });

  it("stops polling on an invalid_request payload error -- retrying the same identity can't fix it", () => {
    expect(
      nextStatusRefetchInterval({
        queryEnabled: true,
        status: null,
        unsupportedForge: false,
        payloadErrorKind: "invalid_request",
      }),
    ).toBe(false);
  });

  it("keeps polling through a transient payload error like rate_limited or failed", () => {
    expect(
      nextStatusRefetchInterval({
        queryEnabled: true,
        status: null,
        unsupportedForge: false,
        payloadErrorKind: "rate_limited",
      }),
    ).toBe(STATUS_REFETCH_INTERVAL_MS);
    expect(
      nextStatusRefetchInterval({
        queryEnabled: true,
        status: null,
        unsupportedForge: false,
        payloadErrorKind: "failed",
      }),
    ).toBe(STATUS_REFETCH_INTERVAL_MS);
  });
});
