import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { claudeProjectDirSync } from "../providers/claude/project-dir.js";
import { locateAgentTranscript } from "./locate.js";

describe("locateAgentTranscript", () => {
  let root: string;
  let claudeConfigDir: string;
  let codexHome: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paseo-transcript-locate-"));
    claudeConfigDir = join(root, "claude-home");
    codexHome = join(root, "codex-home");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("finds a Claude transcript under the account's projects/ dir", async () => {
    const cwd = "/work/my-project";
    const sessionId = "sess-abc-123";
    const projectDir = claudeProjectDirSync(cwd, { configDir: claudeConfigDir });
    await mkdir(projectDir, { recursive: true });
    const transcriptPath = join(projectDir, `${sessionId}.jsonl`);
    await writeFile(transcriptPath, "", "utf8");

    const result = await locateAgentTranscript(
      { provider: "claude", cwd, sessionId },
      { claudeConfigDir },
    );
    expect(result).toEqual({ status: "found", path: transcriptPath });
  });

  test("reports not_found when the Claude transcript file does not exist", async () => {
    const result = await locateAgentTranscript(
      { provider: "claude", cwd: "/work/none", sessionId: "missing-session" },
      { claudeConfigDir },
    );
    expect(result).toEqual({ status: "not_found" });
  });

  test("finds a Codex rollout file by walking date partitions for the session id", async () => {
    const sessionId = "codex-session-xyz";
    const dayDir = join(codexHome, "sessions", "2026", "09", "30");
    await mkdir(dayDir, { recursive: true });
    const rolloutPath = join(dayDir, `rollout-20260930T120000-${sessionId}.jsonl`);
    await writeFile(rolloutPath, "", "utf8");

    const result = await locateAgentTranscript(
      { provider: "codex", cwd: "/work/anything", sessionId },
      { codexHome },
    );
    expect(result).toEqual({ status: "found", path: rolloutPath });
  });

  test("reports not_found when CODEX_HOME has no sessions dir at all", async () => {
    const result = await locateAgentTranscript(
      { provider: "codex", cwd: "/work/anything", sessionId: "nope" },
      { codexHome: join(root, "does-not-exist") },
    );
    expect(result).toEqual({ status: "not_found" });
  });

  test("reports unsupported for a provider with no known transcript location", async () => {
    const result = await locateAgentTranscript(
      { provider: "opencode", cwd: "/work/anything", sessionId: "sess" },
      { claudeConfigDir, codexHome },
    );
    expect(result).toEqual({ status: "unsupported" });
  });

  test("reports not_found when the agent has no session id yet", async () => {
    const result = await locateAgentTranscript(
      { provider: "claude", cwd: "/work/anything", sessionId: null },
      { claudeConfigDir },
    );
    expect(result).toEqual({ status: "not_found" });
  });
});
