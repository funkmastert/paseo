import { describe, expect, it } from "vitest";
import { isUnsupportedForgeStatusError } from "./use-forge-status-by-identity.js";

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
