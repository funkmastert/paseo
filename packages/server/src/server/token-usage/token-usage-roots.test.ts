import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTranscriptRoots } from "./token-usage-roots.js";

const HOME = path.join(path.sep, "home", "fake-user");

describe("resolveTranscriptRoots", () => {
  it("reads the default homes when nothing points elsewhere", () => {
    expect(resolveTranscriptRoots({ homeDir: HOME, env: {}, rawConfig: null })).toEqual([
      { provider: "claude", dir: path.join(HOME, ".claude", "projects") },
      { provider: "codex", dir: path.join(HOME, ".codex", "sessions") },
    ]);
  });

  it("adds the daemon's own homes and each provider's, once each", () => {
    const roots = resolveTranscriptRoots({
      homeDir: HOME,
      env: { CLAUDE_CONFIG_DIR: path.join(HOME, ".claude-leader"), CODEX_HOME: "~/.codex-work" },
      rawConfig: {
        agents: {
          providers: {
            "claude-personal": { env: { CLAUDE_CONFIG_DIR: "~/.claude-personal" } },
            "claude-backup": { env: { CLAUDE_CONFIG_DIR: path.join(HOME, ".claude") } },
            "claude-leader": { env: { CLAUDE_CONFIG_DIR: path.join(HOME, ".claude-leader") } },
            codex: { env: {} },
            broken: "not an object",
          },
        },
      },
    });

    expect(roots).toEqual([
      { provider: "claude", dir: path.join(HOME, ".claude", "projects") },
      { provider: "claude", dir: path.join(HOME, ".claude-leader", "projects") },
      { provider: "claude", dir: path.join(HOME, ".claude-personal", "projects") },
      { provider: "codex", dir: path.join(HOME, ".codex", "sessions") },
      { provider: "codex", dir: path.join(HOME, ".codex-work", "sessions") },
    ]);
  });
});
