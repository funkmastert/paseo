import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  DEFAULT_REGEX_WORKER_TIMEOUT_MS,
  detectBackend,
  parseRipgrepOutput,
  resetBackendDetectionForTests,
  searchWithNode,
  searchWithNodeRegexWorker,
  searchWithRipgrep,
  type ClaudeBinaryResolver,
  type ProcessRunner,
} from "./backend.js";

describe("parseRipgrepOutput", () => {
  test("parses line-numbered rg output", () => {
    expect(parseRipgrepOutput("3:hello world\n7:another hello\n")).toEqual([
      { lineNumber: 3, line: "hello world" },
      { lineNumber: 7, line: "another hello" },
    ]);
  });

  test("ignores lines without a line-number prefix", () => {
    expect(parseRipgrepOutput("garbage\n")).toEqual([]);
  });

  test("preserves colons inside the matched text", () => {
    expect(parseRipgrepOutput('2:{"a":"b"}\n')).toEqual([{ lineNumber: 2, line: '{"a":"b"}' }]);
  });
});

const NO_CLAUDE_BINARY: ClaudeBinaryResolver = { resolve: async () => null };

describe("detectBackend", () => {
  beforeEach(() => resetBackendDetectionForTests());

  test("prefers a real rg on PATH", async () => {
    const runner: ProcessRunner = { run: async () => ({ stdout: "ripgrep 14.1.1", exitCode: 0 }) };
    const claudeBinary: ClaudeBinaryResolver = {
      resolve: async () => {
        throw new Error("must not be consulted when PATH rg is available");
      },
    };
    await expect(detectBackend(runner, claudeBinary)).resolves.toEqual({
      label: "ripgrep",
      invocation: { command: "rg" },
    });
  });

  test("falls back to the Claude binary run as rg when PATH rg is missing", async () => {
    const runner: ProcessRunner = {
      run: async (cmd) => {
        if (cmd === "rg") throw new Error("spawn rg ENOENT");
        return { stdout: "ripgrep 14.1.1", exitCode: 0 };
      },
    };
    const claudeBinary: ClaudeBinaryResolver = { resolve: async () => "/opt/claude/claude" };
    await expect(detectBackend(runner, claudeBinary)).resolves.toEqual({
      label: "ripgrep (claude)",
      invocation: { command: "/opt/claude/claude", argv0: "rg" },
    });
  });

  test("probes the Claude binary with argv0 rg", async () => {
    const seen: Array<{ cmd: string; args: string[]; argv0?: string }> = [];
    const runner: ProcessRunner = {
      run: async (cmd, args, options) => {
        seen.push({ cmd, args, argv0: options?.argv0 });
        if (cmd === "rg") throw new Error("ENOENT");
        return { stdout: "", exitCode: 0 };
      },
    };
    await detectBackend(runner, { resolve: async () => "/opt/claude/claude" });
    expect(seen).toContainEqual({ cmd: "/opt/claude/claude", args: ["--version"], argv0: "rg" });
  });

  test("falls back to node when neither rg nor the Claude binary work", async () => {
    const runner: ProcessRunner = {
      run: async () => {
        throw new Error("ENOENT");
      },
    };
    await expect(detectBackend(runner, NO_CLAUDE_BINARY)).resolves.toEqual({ label: "node" });
  });

  test("falls back to node when the Claude binary resolves but fails to probe", async () => {
    const runner: ProcessRunner = {
      run: async () => ({ stdout: "", exitCode: 1 }),
    };
    await expect(
      detectBackend(runner, { resolve: async () => "/opt/claude/claude" }),
    ).resolves.toEqual({ label: "node" });
  });

  test("caches the result across calls", async () => {
    let calls = 0;
    const runner: ProcessRunner = {
      run: async () => {
        calls += 1;
        return { stdout: "", exitCode: 0 };
      },
    };
    await detectBackend(runner, NO_CLAUDE_BINARY);
    await detectBackend(runner, NO_CLAUDE_BINARY);
    expect(calls).toBe(1);
  });
});

describe("searchWithRipgrep (mocked process runner)", () => {
  test("reports truncated when more than maxMatches are found", async () => {
    const runner: ProcessRunner = {
      run: async () => ({ stdout: "1:a\n2:a\n3:a\n", exitCode: 0 }),
    };
    const result = await searchWithRipgrep(
      "/fake/path.jsonl",
      { pattern: "a", regex: false, caseInsensitive: false },
      2,
      { command: "rg" },
      runner,
    );
    expect(result.truncated).toBe(true);
    expect(result.matches).toHaveLength(2);
  });

  test("exit code 1 (no matches) is not an error", async () => {
    const runner: ProcessRunner = { run: async () => ({ stdout: "", exitCode: 1 }) };
    const result = await searchWithRipgrep(
      "/fake/path.jsonl",
      { pattern: "nope", regex: false, caseInsensitive: false },
      10,
      { command: "rg" },
      runner,
    );
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  test("a non-0/1 exit code throws", async () => {
    const runner: ProcessRunner = { run: async () => ({ stdout: "", exitCode: 2 }) };
    await expect(
      searchWithRipgrep(
        "/fake/path.jsonl",
        { pattern: "a", regex: false, caseInsensitive: false },
        10,
        { command: "rg" },
        runner,
      ),
    ).rejects.toThrow();
  });

  test("invokes the Claude-as-rg binary with argv0 when the invocation names one", async () => {
    const seen: Array<{ cmd: string; argv0?: string }> = [];
    const runner: ProcessRunner = {
      run: async (cmd, _args, options) => {
        seen.push({ cmd, argv0: options?.argv0 });
        return { stdout: "", exitCode: 1 };
      },
    };
    await searchWithRipgrep(
      "/fake/path.jsonl",
      { pattern: "a", regex: false, caseInsensitive: false },
      10,
      { command: "/opt/claude/claude", argv0: "rg" },
      runner,
    );
    expect(seen).toEqual([{ cmd: "/opt/claude/claude", argv0: "rg" }]);
  });
});

describe("searchWithNode", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-transcript-search-backend-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("finds literal matches, case-sensitive by default", async () => {
    const file = join(dir, "t.jsonl");
    await writeFile(file, "alpha\nBeta\nalphabet\n", "utf8");
    const result = await searchWithNode(
      file,
      { pattern: "alpha", regex: false, caseInsensitive: false },
      10,
    );
    expect(result.matches.map((m) => m.lineNumber)).toEqual([1, 3]);
    expect(result.truncated).toBe(false);
  });

  test("case-insensitive literal match", async () => {
    const file = join(dir, "t.jsonl");
    await writeFile(file, "alpha\nBeta\n", "utf8");
    const result = await searchWithNode(
      file,
      { pattern: "beta", regex: false, caseInsensitive: true },
      10,
    );
    expect(result.matches.map((m) => m.lineNumber)).toEqual([2]);
  });

  test("regex match", async () => {
    const file = join(dir, "t.jsonl");
    await writeFile(file, "foo123\nbar\nfoo456\n", "utf8");
    const result = await searchWithNode(
      file,
      { pattern: "foo\\d+", regex: true, caseInsensitive: false },
      10,
    );
    expect(result.matches.map((m) => m.lineNumber)).toEqual([1, 3]);
  });

  test("stops early and reports truncated once over the cap", async () => {
    const file = join(dir, "t.jsonl");
    await writeFile(file, "a\na\na\na\n", "utf8");
    const result = await searchWithNode(
      file,
      { pattern: "a", regex: false, caseInsensitive: false },
      2,
    );
    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});

describe("searchWithNodeRegexWorker", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-transcript-search-worker-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("finds regex matches off the main thread", async () => {
    const file = join(dir, "t.jsonl");
    await writeFile(file, "foo123\nbar\nfoo456\n", "utf8");
    const outcome = await searchWithNodeRegexWorker(
      file,
      { pattern: "foo\\d+", regex: true, caseInsensitive: false },
      10,
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.matches.map((m) => m.lineNumber)).toEqual([1, 3]);
      expect(outcome.truncated).toBe(false);
    }
  });

  test("reports truncated once over the cap", async () => {
    const file = join(dir, "t.jsonl");
    await writeFile(file, "a\na\na\na\n", "utf8");
    const outcome = await searchWithNodeRegexWorker(
      file,
      { pattern: "a", regex: true, caseInsensitive: false },
      2,
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.matches).toHaveLength(2);
      expect(outcome.truncated).toBe(true);
    }
  });

  test("kills a catastrophically backtracking regex instead of hanging", async () => {
    const file = join(dir, "t.jsonl");
    // Classic ReDoS shape: exponential backtracking against a near-miss input.
    await writeFile(file, `${"a".repeat(32)}!\n`, "utf8");
    const outcome = await searchWithNodeRegexWorker(
      file,
      { pattern: "^(a+)+$", regex: true, caseInsensitive: false },
      10,
      100,
    );
    expect(outcome.status).toBe("timed_out");
  }, 15_000);

  test("the default deadline is 10 seconds", () => {
    expect(DEFAULT_REGEX_WORKER_TIMEOUT_MS).toBe(10_000);
  });
});
