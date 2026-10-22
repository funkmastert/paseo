import { describe, expect, it } from "vitest";
import { prPaneStatusByIdentityQueryKey } from "./query-keys";

describe("prPaneStatusByIdentityQueryKey", () => {
  it("differs for two different identities under the same serverId/cwd", () => {
    const base = { serverId: "server-1", host: "github.com", repoOwner: "acme" };
    const keyA = prPaneStatusByIdentityQueryKey({ ...base, repoName: "widgets", number: 1 });
    const keyB = prPaneStatusByIdentityQueryKey({ ...base, repoName: "widgets", number: 2 });
    expect(keyA).not.toEqual(keyB);
  });
});
