import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, test } from "vitest";

import {
  captureJevKeyFromEnv,
  createJevKeyResolver,
  JEV_KEY_ENV,
  type JevKeyResolverOptions,
} from "./key.js";

const FAKE_KEY = "fake-jev-key-0123456789abcdef-do-not-use";
const ENV_FILE = "/fake/home/.config/paseo/jev.env";

function capturingLogger(): { logger: pino.Logger; text: () => string } {
  let text = "";
  const logger = pino(
    { level: "trace" },
    new Writable({
      write(chunk, _encoding, callback) {
        text += chunk.toString();
        callback();
      },
    }),
  );
  return { logger, text: () => text };
}

describe("captureJevKeyFromEnv", () => {
  test("captures the key once and removes it from env", () => {
    const env: NodeJS.ProcessEnv = { [JEV_KEY_ENV]: FAKE_KEY, PATH: "/usr/bin" };
    const captured = captureJevKeyFromEnv(env);
    expect(captured.present).toBe(true);
    expect(captured.value()).toBe(FAKE_KEY);
    expect(env[JEV_KEY_ENV]).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  test("also strips the key from every record in alsoStrip", () => {
    const env: NodeJS.ProcessEnv = { [JEV_KEY_ENV]: FAKE_KEY };
    const mirror: Record<string, string | undefined> = { [JEV_KEY_ENV]: FAKE_KEY, OTHER: "x" };
    captureJevKeyFromEnv(env, [mirror, undefined]);
    expect(mirror[JEV_KEY_ENV]).toBeUndefined();
    expect(mirror.OTHER).toBe("x");
  });

  test("reports absent when no key was set", () => {
    const captured = captureJevKeyFromEnv({});
    expect(captured.present).toBe(false);
    expect(captured.value()).toBeNull();
  });
});

function makeResolver(
  overrides: Partial<JevKeyResolverOptions> & { logger: pino.Logger },
): ReturnType<typeof createJevKeyResolver> {
  return createJevKeyResolver({
    captured: captureJevKeyFromEnv({}),
    platform: "darwin",
    readFile: () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    statMode: () => null,
    ...overrides,
  });
}

describe("createJevKeyResolver", () => {
  test("the env file wins over the captured env", () => {
    const { logger } = capturingLogger();
    const resolver = makeResolver({
      logger,
      captured: captureJevKeyFromEnv({ [JEV_KEY_ENV]: "from-env-should-lose-0123456789" }),
      readFile: () => `${JEV_KEY_ENV}=${FAKE_KEY}\n`,
      statMode: () => 0o600,
    });
    expect(resolver.resolve(ENV_FILE)).toEqual({ key: FAKE_KEY, source: "env-file" });
  });

  test("a missing file falls back to the captured env", () => {
    const { logger } = capturingLogger();
    const resolver = makeResolver({
      logger,
      captured: captureJevKeyFromEnv({ [JEV_KEY_ENV]: FAKE_KEY }),
    });
    expect(resolver.resolve(ENV_FILE)).toEqual({ key: FAKE_KEY, source: "env" });
  });

  test("no key anywhere resolves to null", () => {
    const { logger } = capturingLogger();
    const resolver = makeResolver({ logger });
    expect(resolver.resolve(ENV_FILE)).toEqual({ key: null, source: null });
  });

  test("OPENROUTER_API_KEY and TYPESAFE_API_KEY are never read", () => {
    const { logger } = capturingLogger();
    const resolver = makeResolver({
      logger,
      captured: captureJevKeyFromEnv({
        OPENROUTER_API_KEY: "or-key-should-not-be-used-0123456789",
        TYPESAFE_API_KEY: "ts-key-should-not-be-used-0123456789",
      }),
    });
    expect(resolver.resolve(ENV_FILE)).toEqual({ key: null, source: null });
  });

  test("a group- or other-readable env file is still read, with one warning naming the path", () => {
    const { logger, text } = capturingLogger();
    const resolver = makeResolver({
      logger,
      readFile: () => `${JEV_KEY_ENV}=${FAKE_KEY}\n`,
      statMode: () => 0o644,
    });
    expect(resolver.resolve(ENV_FILE)).toEqual({ key: FAKE_KEY, source: "env-file" });
    resolver.resolve(ENV_FILE);
    const warnings = text()
      .split("\n")
      .filter((line) => line.includes("chmod 600"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(ENV_FILE);
    expect(warnings[0]).not.toContain(FAKE_KEY);
  });

  test("skips the readable-mode warning on win32", () => {
    const { logger, text } = capturingLogger();
    const resolver = makeResolver({
      logger,
      platform: "win32",
      readFile: () => `${JEV_KEY_ENV}=${FAKE_KEY}\n`,
      statMode: () => {
        throw new Error("statMode should not be called on win32");
      },
    });
    expect(resolver.resolve(ENV_FILE)).toEqual({ key: FAKE_KEY, source: "env-file" });
    expect(text()).not.toContain("chmod 600");
  });

  test("the fake key never appears in a log line", () => {
    const { logger, text } = capturingLogger();
    const resolver = makeResolver({
      logger,
      readFile: () => `${JEV_KEY_ENV}=${FAKE_KEY}\n`,
      statMode: () => 0o640,
    });
    resolver.resolve(ENV_FILE);
    expect(text()).not.toContain(FAKE_KEY);
  });
});
