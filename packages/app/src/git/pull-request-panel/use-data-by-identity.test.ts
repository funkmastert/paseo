import { describe, expect, it } from "vitest";
import { isUnsupportedForgeStatusError } from "./use-data-by-identity.js";
import { prPaneStatusByIdentityQueryKey } from "./query-keys.js";

describe("isUnsupportedForgeStatusError", () => {
  it("is true for the daemon's typed unsupported_forge error", () => {
    expect(
      isUnsupportedForgeStatusError({ payloadErrorKind: "unsupported_forge", queryError: null }),
    ).toBe(true);
  });

  it("is true for an old daemon's unknown_schema rpc error", () => {
    const error = new Error("unknown schema") as Error & { code: string };
    error.code = "unknown_schema";
    expect(isUnsupportedForgeStatusError({ payloadErrorKind: null, queryError: error })).toBe(true);
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

describe("prPaneStatusByIdentityQueryKey", () => {
  it("differs for two different identities under the same serverId/cwd", () => {
    const base = { serverId: "server-1", host: "github.com", repoOwner: "acme" };
    const keyA = prPaneStatusByIdentityQueryKey({ ...base, repoName: "widgets", number: 1 });
    const keyB = prPaneStatusByIdentityQueryKey({ ...base, repoName: "widgets", number: 2 });
    expect(keyA).not.toEqual(keyB);
  });
});
