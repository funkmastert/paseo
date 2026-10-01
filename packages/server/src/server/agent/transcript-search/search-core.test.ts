import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { claudeProjectDirSync } from "../providers/claude/project-dir.js";
import { searchTranscripts, type TranscriptSearchTarget } from "./search-core.js";

const backendMocks = vi.hoisted(() => ({
  detectBackend: vi.fn(),
  searchWithNodeRegexWorker: vi.fn(),
}));

// The backend *choice* and the regex-worker outcome are mocked, so tests are deterministic
// regardless of whether the machine running them has a real `rg` on PATH, and without waiting out
// a real worker deadline here (the worker itself, including a genuine timeout, is covered in
// backend.test.ts). The actual line search (ripgrep or node literal) and text extraction run for
// real against fixture files.
vi.mock("./backend.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./backend.js")>()),
  detectBackend: backendMocks.detectBackend,
  searchWithNodeRegexWorker: backendMocks.searchWithNodeRegexWorker,
}));

function baseQuery(overrides: Partial<Parameters<typeof searchTranscripts>[1]> = {}) {
  return {
    pattern: "auth bug",
    regex: false,
    caseInsensitive: false,
    maxMatchesPerAgent: 10,
    maxExcerptChars: 200,
    maxTotalBytes: 100_000,
    ...overrides,
  };
}

function row(role: string, text: string): string {
  return JSON.stringify({ type: role, message: { role, content: [{ type: "text", text }] } });
}

describe("searchTranscripts", () => {
  let root: string;
  let claudeConfigDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paseo-transcript-search-core-"));
    claudeConfigDir = join(root, "claude-home");
    backendMocks.detectBackend.mockReset();
    backendMocks.searchWithNodeRegexWorker.mockReset();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeClaudeTranscript(cwd: string, sessionId: string, lines: string[]) {
    const projectDir = claudeProjectDirSync(cwd, { configDir: claudeConfigDir });
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, `${sessionId}.jsonl`), lines.join("\n") + "\n", "utf8");
  }

  test("searches a found transcript with the node backend and extracts readable excerpts", async () => {
    backendMocks.detectBackend.mockResolvedValue({ label: "node" });
    await writeClaudeTranscript("/work/proj", "sess-1", [
      row("user", "please find the auth bug"),
      row("assistant", "looking at auth.ts now"),
      row("user", "unrelated line"),
    ]);
    const targets: TranscriptSearchTarget[] = [
      {
        agentId: "a1",
        title: "Agent One",
        provider: "claude",
        cwd: "/work/proj",
        sessionId: "sess-1",
      },
    ];
    const result = await searchTranscripts(targets, baseQuery({ pattern: "auth" }), {
      claudeConfigDir,
    });
    expect(result.backend).toBe("node");
    expect(result.agents).toHaveLength(1);
    const [agent] = result.agents;
    expect(agent.coverage).toBe("searched");
    expect(agent.matchCount).toBe(2);
    expect(agent.excerpts[0]).toMatchObject({ role: "user", lineNumber: 1 });
    expect(agent.excerpts[0]?.text).toContain("find the auth bug");
    expect(agent.excerpts.every((e) => !e.text.includes("{"))).toBe(true);
  });

  test("reports the ripgrep label honestly even when the run falls back internally", async () => {
    // No real rg binary is assumed present in this environment; search-core must fall back to a
    // working search without losing coverage, while still reporting what backend it chose.
    backendMocks.detectBackend.mockResolvedValue({
      label: "ripgrep",
      invocation: { command: "rg" },
    });
    await writeClaudeTranscript("/work/proj2", "sess-2", [row("user", "auth bug here")]);
    const targets: TranscriptSearchTarget[] = [
      { agentId: "a2", title: null, provider: "claude", cwd: "/work/proj2", sessionId: "sess-2" },
    ];
    const result = await searchTranscripts(targets, baseQuery({ pattern: "auth bug" }), {
      claudeConfigDir,
    });
    expect(result.backend).toBe("ripgrep");
    expect(result.agents[0]?.coverage).toBe("searched");
    expect(result.agents[0]?.matchCount).toBe(1);
  });

  test("coverage is not_found when the agent has a session id but no transcript file", async () => {
    backendMocks.detectBackend.mockResolvedValue({ label: "node" });
    const targets: TranscriptSearchTarget[] = [
      { agentId: "a3", title: null, provider: "claude", cwd: "/work/none", sessionId: "missing" },
    ];
    const result = await searchTranscripts(targets, baseQuery(), { claudeConfigDir });
    expect(result.agents[0]).toMatchObject({ coverage: "not_found", matchCount: 0, excerpts: [] });
  });

  test("coverage is unsupported for a provider with no known transcript location", async () => {
    backendMocks.detectBackend.mockResolvedValue({ label: "node" });
    const targets: TranscriptSearchTarget[] = [
      { agentId: "a4", title: null, provider: "opencode", cwd: "/work/x", sessionId: "sess" },
    ];
    const result = await searchTranscripts(targets, baseQuery(), { claudeConfigDir });
    expect(result.agents[0]).toMatchObject({
      coverage: "unsupported",
      matchCount: 0,
      excerpts: [],
    });
  });

  test("coverage is truncated when more matches exist than the per-agent cap", async () => {
    backendMocks.detectBackend.mockResolvedValue({ label: "node" });
    await writeClaudeTranscript(
      "/work/many",
      "sess-many",
      Array.from({ length: 5 }, (_, i) => row("user", `auth bug number ${i}`)),
    );
    const targets: TranscriptSearchTarget[] = [
      { agentId: "a5", title: null, provider: "claude", cwd: "/work/many", sessionId: "sess-many" },
    ];
    const result = await searchTranscripts(
      targets,
      baseQuery({ pattern: "auth bug", maxMatchesPerAgent: 2 }),
      { claudeConfigDir },
    );
    expect(result.agents[0]?.coverage).toBe("truncated");
    expect(result.agents[0]?.matchCount).toBe(2);
  });

  test("coverage is truncated by the total byte budget, and later agents are not attempted", async () => {
    backendMocks.detectBackend.mockResolvedValue({ label: "node" });
    await writeClaudeTranscript("/work/big1", "sess-big1", [row("user", "auth bug one")]);
    await writeClaudeTranscript("/work/big2", "sess-big2", [row("user", "auth bug two")]);
    const targets: TranscriptSearchTarget[] = [
      { agentId: "b1", title: null, provider: "claude", cwd: "/work/big1", sessionId: "sess-big1" },
      { agentId: "b2", title: null, provider: "claude", cwd: "/work/big2", sessionId: "sess-big2" },
    ];
    // A budget smaller than even the first match forces an immediate byte-cap truncation.
    const result = await searchTranscripts(
      targets,
      baseQuery({ pattern: "auth bug", maxTotalBytes: 1 }),
      {
        claudeConfigDir,
      },
    );
    expect(result.agents[0]?.coverage).toBe("truncated");
    expect(result.agents[0]?.excerpts).toEqual([]);
    expect(result.agents[1]?.coverage).toBe("truncated");
    expect(result.agents[1]?.excerpts).toEqual([]);
  });

  test("an invalid regex pattern throws a clear error instead of crashing per-file", async () => {
    backendMocks.detectBackend.mockResolvedValue({ label: "node" });
    const targets: TranscriptSearchTarget[] = [
      { agentId: "a6", title: null, provider: "claude", cwd: "/work/x", sessionId: "sess" },
    ];
    await expect(
      searchTranscripts(targets, baseQuery({ pattern: "(", regex: true }), { claudeConfigDir }),
    ).rejects.toThrow(/Invalid regular expression/);
  });

  test("a line with no extractable text still counts as a match, marked unreadable", async () => {
    backendMocks.detectBackend.mockResolvedValue({ label: "node" });
    const projectDir = claudeProjectDirSync("/work/raw", { configDir: claudeConfigDir });
    await mkdir(projectDir, { recursive: true });
    // A row whose only string value matching the pattern lives nowhere extractText reaches:
    // not valid JSON at all, so the excerpt text falls back to the "unreadable" marker.
    await writeFile(
      join(projectDir, "sess-raw.jsonl"),
      "not json but has auth bug in it\n",
      "utf8",
    );
    const targets: TranscriptSearchTarget[] = [
      { agentId: "a7", title: null, provider: "claude", cwd: "/work/raw", sessionId: "sess-raw" },
    ];
    const result = await searchTranscripts(targets, baseQuery({ pattern: "auth bug" }), {
      claudeConfigDir,
    });
    expect(result.agents[0]?.coverage).toBe("searched");
    expect(result.agents[0]?.excerpts[0]?.text).toBe("(no readable text on this line)");
  });

  test("a regex search on the node backend that times out reports coverage timed_out", async () => {
    backendMocks.detectBackend.mockResolvedValue({ label: "node" });
    backendMocks.searchWithNodeRegexWorker.mockResolvedValue({ status: "timed_out" });
    await writeClaudeTranscript("/work/slow", "sess-slow", [row("user", "auth bug")]);
    const targets: TranscriptSearchTarget[] = [
      { agentId: "a8", title: null, provider: "claude", cwd: "/work/slow", sessionId: "sess-slow" },
    ];
    const result = await searchTranscripts(targets, baseQuery({ pattern: "a+", regex: true }), {
      claudeConfigDir,
    });
    expect(result.agents[0]).toMatchObject({ coverage: "timed_out", matchCount: 0, excerpts: [] });
  });

  test("a regex worker error is reported as not_found rather than crashing the whole search", async () => {
    backendMocks.detectBackend.mockResolvedValue({ label: "node" });
    backendMocks.searchWithNodeRegexWorker.mockResolvedValue({
      status: "error",
      message: "boom",
    });
    await writeClaudeTranscript("/work/err", "sess-err", [row("user", "auth bug")]);
    const targets: TranscriptSearchTarget[] = [
      { agentId: "a9", title: null, provider: "claude", cwd: "/work/err", sessionId: "sess-err" },
    ];
    const result = await searchTranscripts(targets, baseQuery({ pattern: "a+", regex: true }), {
      claudeConfigDir,
    });
    expect(result.agents[0]).toMatchObject({ coverage: "not_found", matchCount: 0, excerpts: [] });
  });

  test("literal search never consults the regex worker", async () => {
    backendMocks.detectBackend.mockResolvedValue({ label: "node" });
    await writeClaudeTranscript("/work/lit", "sess-lit", [row("user", "auth bug")]);
    const targets: TranscriptSearchTarget[] = [
      { agentId: "a10", title: null, provider: "claude", cwd: "/work/lit", sessionId: "sess-lit" },
    ];
    await searchTranscripts(targets, baseQuery({ pattern: "auth bug", regex: false }), {
      claudeConfigDir,
    });
    expect(backendMocks.searchWithNodeRegexWorker).not.toHaveBeenCalled();
  });
});
