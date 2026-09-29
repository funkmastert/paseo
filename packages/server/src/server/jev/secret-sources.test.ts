import { describe, expect, it } from "vitest";

import {
  collectJevSecretValues,
  isSecretEnvName,
  type JevSecretSources,
} from "./secret-sources.js";

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

  it("takes names that only contain a secret word, and never the working directory", () => {
    const result = collectJevSecretValues(
      sources({
        startupEnv: {
          NGROK_AUTHTOKEN: "ngrok-value-111111",
          PGPASSWORD: "pg-value-2222222",
          PWD: "/Users/x/paseo-worktrees/jev-foundation",
          OLDPWD: "/Users/x/paseo-worktrees",
        },
      }),
      null,
    );
    expect(values(result)).toEqual(["ngrok-value-111111", "pg-value-2222222"]);
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

describe("isSecretEnvName", () => {
  it.each([
    "NGROK_AUTHTOKEN",
    "PGPASSWORD",
    "SSHPASS",
    "APITOKEN",
    "NPM_CONFIG_AUTHTOKEN",
    "GITHUB_TOKEN",
    "GITHUB_TOKEN_2",
    "SECRET_KEY_BASE",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "LINEAR_APIKEY",
    "HTTP_AUTHORIZATION",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "MYSQL_PWD",
    "SENTRY_DSN",
  ])("collects %s", (name) => {
    expect(isSecretEnvName(name)).toBe(true);
  });

  it.each([
    "PWD",
    "OLDPWD",
    "HOME",
    "PATH",
    "TMPDIR",
    "SSH_AUTH_SOCK",
    "GIT_AUTHOR_NAME",
    "AWS_ACCESS_KEY_ID",
    "NODE_ENV",
  ])("skips %s", (name) => {
    expect(isSecretEnvName(name)).toBe(false);
  });
});
