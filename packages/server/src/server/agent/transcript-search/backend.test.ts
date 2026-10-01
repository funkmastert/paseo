import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  detectBackend,
  parseRipgrepOutput,
  resetBackendDetectionForTests,
  searchWithNode,
  searchWithRipgrep,
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

describe("detectBackend", () => {
  beforeEach(() => resetBackendDetectionForTests());

  test("reports ripgrep when the probe succeeds", async () => {
    const runner: ProcessRunner = { run: async () => ({ stdout: "ripgrep 14.1.1", exitCode: 0 }) };
    await expect(detectBackend(runner)).resolves.toBe("ripgrep");
  });

  test("falls back to node when the probe fails (binary missing)", async () => {
    const runner: ProcessRunner = {
      run: async () => {
        throw new Error("spawn rg ENOENT");
      },
    };
    await expect(detectBackend(runner)).resolves.toBe("node");
  });

  test("caches the result across calls", async () => {
    let calls = 0;
    const runner: ProcessRunner = {
      run: async () => {
        calls += 1;
        return { stdout: "", exitCode: 0 };
      },
    };
    await detectBackend(runner);
    await detectBackend(runner);
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
        runner,
      ),
    ).rejects.toThrow();
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
