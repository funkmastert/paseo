import { describe, expect, test } from "vitest";

import { deriveSetupHint, type SetupHintInput } from "./setup-hint.js";

const slackHost = "https://mcp.slack.com/mcp";

function hint(overrides: Partial<SetupHintInput>) {
  return deriveSetupHint({
    name: "other",
    url: "https://example.test/mcp",
    isStatic: false,
    unhealthy: true,
    hasStoredTokens: () => false,
    hasClientCredentials: () => false,
    registrationUnsupported: false,
    ...overrides,
  });
}

describe("a server a local-server preset replaces", () => {
  test("offers the token form while hosted and unhealthy", () => {
    expect(hint({ name: "figma", url: "https://mcp.figma.com/mcp" })).toBe("local_token");
  });

  test("offers nothing while hosted and healthy", () => {
    expect(hint({ name: "figma", url: "https://mcp.figma.com/mcp", unhealthy: false })).toBe(
      undefined,
    );
  });

  test.each([
    ["healthy", false],
    ["unhealthy", true],
  ])("keeps offering the token form once it runs locally and is %s", (_label, unhealthy) => {
    expect(hint({ name: "figma", url: undefined, isStatic: true, unhealthy })).toBe("local_token");
  });
});

describe("reading the token file", () => {
  test("a healthy server, or one a preset replaces, never reads it", () => {
    const reads: string[] = [];
    const tracking = {
      hasStoredTokens: () => reads.push("tokens") > 0,
      hasClientCredentials: () => reads.push("credentials") > 0,
    };
    hint({ ...tracking, name: "slack", url: slackHost, unhealthy: false });
    hint({ ...tracking, name: "figma", url: undefined, isStatic: true });
    hint({ ...tracking, name: "figma", url: "https://mcp.figma.com/mcp" });
    expect(reads).toEqual([]);
  });
});

describe("an OAuth server that cannot register an app", () => {
  test("offers the credentials form on a host known to refuse registration", () => {
    expect(hint({ name: "slack", url: slackHost })).toBe("client_credentials");
  });

  test("offers it for an unlisted host once a sign-in was refused for lack of an app", () => {
    expect(hint({ registrationUnsupported: true })).toBe("client_credentials");
  });

  test("keeps offering it after credentials are saved, because they may be wrong", () => {
    expect(hint({ name: "slack", url: slackHost, hasClientCredentials: () => true })).toBe(
      "client_credentials",
    );
    expect(hint({ hasClientCredentials: () => true })).toBe("client_credentials");
  });

  test("stops once a sign-in has stored tokens", () => {
    expect(
      hint({
        name: "slack",
        url: slackHost,
        hasClientCredentials: () => true,
        hasStoredTokens: () => true,
      }),
    ).toBe(undefined);
  });

  test("offers nothing while healthy", () => {
    expect(hint({ name: "slack", url: slackHost, unhealthy: false })).toBe(undefined);
  });

  test("offers nothing for a static-auth entry or an ordinary OAuth server", () => {
    expect(hint({ name: "slack", url: slackHost, isStatic: true })).toBe(undefined);
    expect(hint({})).toBe(undefined);
  });
});
