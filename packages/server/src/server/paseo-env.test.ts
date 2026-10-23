import { afterEach, describe, expect, test } from "vitest";
import {
  buildSelfNodeCommand,
  configureChildEnvStrip,
  createExternalCommandProcessEnv,
  createExternalProcessEnv,
  createPaseoInternalEnv,
  DEFAULT_CHILD_ENV_STRIP,
  resolvePaseoNodeEnv,
  SECRET_ENV_KEYS,
} from "./paseo-env.js";

describe("paseo env contract", () => {
  const ELECTRON_RUN_AS_NODE = "ELECTRON_RUN_AS_NODE";
  const PASEO_NODE_ENV = "PASEO_NODE_ENV";
  const baseEnv = {
    [ELECTRON_RUN_AS_NODE]: "1",
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    NODE_ENV: "development",
    PATH: "/usr/bin",
    PASEO_AGENT_ID: "agent-123",
    PASEO_DESKTOP_MANAGED: "1",
    [PASEO_NODE_ENV]: "production",
    PASEO_SUPERVISED: "1",
    ESBUILD_BINARY_PATH: "/Applications/Paseo.app/Contents/Resources/app.asar.unpacked/esbuild",
  };
  const runtimeControlEnvKeys = [
    "ELECTRON_RUN_AS_NODE",
    "PASEO_NODE_ENV",
    "PASEO_DESKTOP_MANAGED",
    "PASEO_SUPERVISED",
    "ELECTRON_NO_ATTACH_CONSOLE",
    "ESBUILD_BINARY_PATH",
  ] as const;

  test("builds internal daemon child env by preserving pass-through and control vars", () => {
    const env = createPaseoInternalEnv(baseEnv);

    expect(env).toMatchObject({
      [ELECTRON_RUN_AS_NODE]: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      NODE_ENV: "development",
      PATH: "/usr/bin",
      PASEO_DESKTOP_MANAGED: "1",
      [PASEO_NODE_ENV]: "production",
      PASEO_SUPERVISED: "1",
      PASEO_AGENT_ID: "agent-123",
    });
  });

  test("builds external process env by scrubbing runtime control vars after overlays", () => {
    const env = createExternalProcessEnv(baseEnv, {
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      ELECTRON_RUN_AS_NODE: "0",
      EXTRA_VALUE: "from-overlay",
      PASEO_DESKTOP_MANAGED: "1",
      PASEO_NODE_ENV: "test",
      PASEO_SUPERVISED: "1",
      PATH: "/custom/bin",
    });

    for (const key of runtimeControlEnvKeys) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.NODE_ENV).toBe("development");
    expect(env.PASEO_AGENT_ID).toBe("agent-123");
    expect(env.PATH).toBe("/custom/bin");
  });

  test("applies non-control overlays to external process env", () => {
    const env = createExternalProcessEnv(baseEnv, { PATH: "/custom/bin" }, { CUSTOM: "value" });

    expect(env.CUSTOM).toBe("value");
    expect(env.NODE_ENV).toBe("development");
    expect(env.PATH).toBe("/custom/bin");
  });

  test("builds external command env without process.execPath special-casing", () => {
    const env = createExternalCommandProcessEnv(process.execPath, baseEnv, {
      ELECTRON_RUN_AS_NODE: "0",
      PASEO_NODE_ENV: "test",
    });

    expect(env[ELECTRON_RUN_AS_NODE]).toBeUndefined();
    expect(env.NODE_ENV).toBe("development");
    expect(env.PASEO_AGENT_ID).toBe("agent-123");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined();
    expect(env.PASEO_DESKTOP_MANAGED).toBeUndefined();
    expect(env[PASEO_NODE_ENV]).toBeUndefined();
    expect(env.PASEO_SUPERVISED).toBeUndefined();
  });

  test("builds self node command with Electron node mode", () => {
    const command = buildSelfNodeCommand(["script.js"], {
      CUSTOM: "value",
    });

    expect(command.command).toBe(process.execPath);
    expect(command.args).toEqual(["script.js"]);
    expect(command.env[ELECTRON_RUN_AS_NODE]).toBe("1");
    expect(command.env.CUSTOM).toBe("value");
    expect(command.env.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined();
    expect(command.env.PASEO_DESKTOP_MANAGED).toBeUndefined();
    expect(command.env[PASEO_NODE_ENV]).toBeUndefined();
    expect(command.env.PASEO_SUPERVISED).toBeUndefined();
  });

  test("does not add Electron node mode for non-execPath commands", () => {
    const env = createExternalCommandProcessEnv("node", baseEnv, {
      ELECTRON_RUN_AS_NODE: "1",
    });

    expect(env[ELECTRON_RUN_AS_NODE]).toBeUndefined();
  });

  test("strips PASEO_JEV_API_KEY from the internal daemon child env", () => {
    const env = createPaseoInternalEnv({ ...baseEnv, PASEO_JEV_API_KEY: "fake-jev-key" });
    expect(env.PASEO_JEV_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  test("strips PASEO_JEV_API_KEY from the external process env", () => {
    const env = createExternalProcessEnv({ ...baseEnv, PASEO_JEV_API_KEY: "fake-jev-key" });
    expect(env.PASEO_JEV_API_KEY).toBeUndefined();
  });

  test("SECRET_ENV_KEYS names PASEO_JEV_API_KEY", () => {
    expect(SECRET_ENV_KEYS).toContain("PASEO_JEV_API_KEY");
  });

  test("does not use user NODE_ENV as Paseo runtime mode", () => {
    expect(resolvePaseoNodeEnv({ NODE_ENV: "development" })).toBeUndefined();
    expect(resolvePaseoNodeEnv({ NODE_ENV: "development", PASEO_NODE_ENV: "production" })).toBe(
      "production",
    );
    expect(resolvePaseoNodeEnv({ NODE_ENV: "test", PASEO_NODE_ENV: "local" })).toBeUndefined();
  });
});

describe("agents.childEnv.strip", () => {
  afterEach(() => configureChildEnvStrip(undefined));

  const daemonEnv = {
    PATH: "/usr/bin",
    BIBLIO_ACCESS_TOKEN: "fake-biblio-access-token",
    BIBLIO_CLIENT_SECRET: "fake-biblio-client-secret",
    OPENAI_API_KEY: "fake-openai-key",
    FIGMA_TOKEN: "fake-figma-token",
    ANTHROPIC_API_KEY: "fake-anthropic-key",
    CLAUDE_CODE_OAUTH_TOKEN: "fake-claude-oauth-token",
    CLAUDE_CONFIG_DIR: "/daemon/.claude",
  };

  test("by default strips the retired Biblio credentials from what agents and terminals inherit", () => {
    expect(DEFAULT_CHILD_ENV_STRIP).toEqual(["BIBLIO_*"]);
    const env = createExternalProcessEnv(daemonEnv);
    expect(env.BIBLIO_ACCESS_TOKEN).toBeUndefined();
    expect(env.BIBLIO_CLIENT_SECRET).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  test("by default keeps what providers authenticate with, and keys an agent may use", () => {
    const env = createExternalProcessEnv(daemonEnv);
    expect(env.ANTHROPIC_API_KEY).toBe("fake-anthropic-key");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("fake-claude-oauth-token");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/daemon/.claude");
    expect(env.OPENAI_API_KEY).toBe("fake-openai-key");
    expect(env.FIGMA_TOKEN).toBe("fake-figma-token");
  });

  test("a configured name leaves the inherited env, but a provider overlay that sets it still reaches the child", () => {
    configureChildEnvStrip(["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"]);
    const env = createExternalProcessEnv(daemonEnv, { CLAUDE_CONFIG_DIR: "/provider/.claude" });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/provider/.claude");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.BIBLIO_ACCESS_TOKEN).toBe("fake-biblio-access-token");
  });

  test("a trailing * strips every inherited name with that prefix, and nothing else", () => {
    configureChildEnvStrip(["FIGMA_*", "OPENAI_API_KEY"]);
    const env = createExternalCommandProcessEnv("git", { ...daemonEnv, FIGMA_OTHER: "x" });
    expect(env.FIGMA_TOKEN).toBeUndefined();
    expect(env.FIGMA_OTHER).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("fake-anthropic-key");
  });

  test("an empty list strips nothing but the JEV key", () => {
    configureChildEnvStrip([]);
    const env = createExternalProcessEnv({ ...daemonEnv, PASEO_JEV_API_KEY: "fake-jev-key" });
    expect(env.BIBLIO_ACCESS_TOKEN).toBe("fake-biblio-access-token");
    expect(env.PASEO_JEV_API_KEY).toBeUndefined();
  });

  test("the JEV key never reaches a child, even from an overlay", () => {
    configureChildEnvStrip([]);
    const env = createExternalProcessEnv(daemonEnv, { PASEO_JEV_API_KEY: "fake-jev-key" });
    expect(env.PASEO_JEV_API_KEY).toBeUndefined();
    const command = buildSelfNodeCommand(["script.js"], { PASEO_JEV_API_KEY: "fake-jev-key" });
    expect(command.env.PASEO_JEV_API_KEY).toBeUndefined();
  });
});
