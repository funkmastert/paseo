import { describe, expect, it } from "vitest";

import { collectJevSecretValues, type JevSecretSources } from "./secret-sources.js";

function sources(overrides: Partial<JevSecretSources> = {}): JevSecretSources {
  return {
    startupEnv: {},
    runTokens: [],
    daemonSecrets: () => [],
    gatewayTokens: () => [],
    rawConfig: () => null,
    readFile: () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    ...overrides,
  };
}

function values(result: ReturnType<typeof collectJevSecretValues>): string[] {
  return result.map((entry) => entry.value).sort();
}

describe("collectJevSecretValues", () => {
  it("collects the key, run tokens, daemon secrets and gateway tokens", () => {
    const result = collectJevSecretValues(
      sources({
        runTokens: ["mcp-token-aaaaaaaa", "gateway-token-bbbbbbbb"],
        daemonSecrets: () => ["relay-secret-cccccccc", null, undefined],
        gatewayTokens: () => ["oauth-access-dddddddd"],
      }),
      "jev-key-eeeeeeee",
    );
    expect(values(result)).toEqual(
      [
        "gateway-token-bbbbbbbb",
        "jev-key-eeeeeeee",
        "mcp-token-aaaaaaaa",
        "oauth-access-dddddddd",
        "relay-secret-cccccccc",
      ].sort(),
    );
    expect(result.every((entry) => entry.kind === "exact")).toBe(true);
  });

  it("takes secret-shaped names from the startup env and provider env blocks", () => {
    const result = collectJevSecretValues(
      sources({
        startupEnv: { GITHUB_TOKEN: "ghp_value_111111", HOME: "/Users/x", PATH: "/bin" },
        rawConfig: () => ({
          agents: {
            providers: { zai: { env: { ZAI_API_KEY: "zai-key-2222222", REGION: "us" } } },
          },
        }),
      }),
      null,
    );
    expect(values(result)).toEqual(["ghp_value_111111", "zai-key-2222222"]);
  });

  it("reads the OpenAI usage key from its variable and env file", () => {
    const result = collectJevSecretValues(
      sources({
        startupEnv: {},
        rawConfig: () => ({
          agents: {
            providerUsage: { openaiApi: { keyEnv: "MY_OPENAI", envFile: "/tmp/openai.env" } },
          },
        }),
        readFile: (filePath) => {
          expect(filePath).toBe("/tmp/openai.env");
          return "MY_OPENAI=sk-file-value-3333\n";
        },
      }),
      null,
    );
    expect(values(result)).toEqual(["sk-file-value-3333"]);
  });

  it("keeps the other sources when one throws", () => {
    const result = collectJevSecretValues(
      sources({
        daemonSecrets: () => {
          throw new Error("keypair unreadable");
        },
        gatewayTokens: () => ["oauth-access-dddddddd"],
      }),
      null,
    );
    expect(values(result)).toEqual(["oauth-access-dddddddd"]);
  });
});
