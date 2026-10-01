import { describe, expect, test } from "vitest";

import { editedPath, recognizeRead, type RecognizedRead } from "./recognize.js";

const CWD = "/repo";
const HOME = "/home/someone";

function bash(command: string, extra: Record<string, unknown> = {}): RecognizedRead | null {
  return recognizeRead({
    toolName: "Bash",
    toolInput: { command, ...extra },
    cwd: CWD,
    home: HOME,
  });
}

function files(read: RecognizedRead | null): Array<{ path: string; range: unknown }> | null {
  return read ? read.files : null;
}

describe("recognizeRead: the Read tool", () => {
  test("a text file reads the Read tool's default page", () => {
    const read = recognizeRead({
      toolName: "Read",
      toolInput: { file_path: "/repo/src/a.ts" },
      cwd: CWD,
      home: HOME,
    });
    expect(read).toEqual({
      tool: "Read",
      files: [{ path: "/repo/src/a.ts", range: { kind: "lines", first: 1, last: 2000 } }],
      filters: [],
      notText: false,
      why: null,
    });
  });

  test("offset and limit narrow the range", () => {
    const read = recognizeRead({
      toolName: "Read",
      toolInput: { file_path: "/repo/a.ts", offset: 100, limit: 50 },
      cwd: CWD,
      home: HOME,
    });
    expect(read?.files[0]?.range).toEqual({ kind: "lines", first: 100, last: 149 });
  });

  test("images, PDF pages and notebooks are not text", () => {
    for (const toolInput of [
      { file_path: "/repo/shot.png" },
      { file_path: "/repo/spec.pdf", pages: "1-3" },
      { file_path: "/repo/analysis.ipynb" },
    ]) {
      expect(recognizeRead({ toolName: "Read", toolInput, cwd: CWD, home: HOME })?.notText).toBe(
        true,
      );
    }
  });

  test("a call without a path is not a read", () => {
    expect(recognizeRead({ toolName: "Read", toolInput: {}, cwd: CWD, home: HOME })).toBeNull();
    expect(recognizeRead({ toolName: "Grep", toolInput: {}, cwd: CWD, home: HOME })).toBeNull();
  });
});

describe("recognizeRead: Bash lines that only read files", () => {
  test("cat reads the whole file, resolved against the walk's cwd", () => {
    expect(files(bash("cat src/a.ts"))).toEqual([
      { path: "/repo/src/a.ts", range: { kind: "all" } },
    ]);
  });

  test("cat with several files reads each", () => {
    expect(files(bash("cat -n a.ts b.ts"))?.map((file) => file.path)).toEqual([
      "/repo/a.ts",
      "/repo/b.ts",
    ]);
  });

  test("head and its count spellings", () => {
    expect(files(bash("head a.ts"))?.[0]?.range).toEqual({ kind: "lines", first: 1, last: 10 });
    expect(files(bash("head -n 50 a.ts"))?.[0]?.range).toEqual({
      kind: "lines",
      first: 1,
      last: 50,
    });
    expect(files(bash("head -n50 a.ts"))?.[0]?.range).toEqual({
      kind: "lines",
      first: 1,
      last: 50,
    });
    expect(files(bash("head -50 a.ts"))?.[0]?.range).toEqual({ kind: "lines", first: 1, last: 50 });
    expect(files(bash("head --lines=7 a.ts"))?.[0]?.range).toEqual({
      kind: "lines",
      first: 1,
      last: 7,
    });
    expect(files(bash("head -c 100 a.ts"))?.[0]?.range).toEqual({
      kind: "first-bytes",
      count: 100,
    });
    // GNU: all but the last 5 lines, so up to the whole file.
    expect(files(bash("head -n -5 a.ts"))?.[0]?.range).toEqual({ kind: "all" });
  });

  test("tail reads the end, or from a line with +N", () => {
    expect(files(bash("tail -n 30 log.txt"))?.[0]?.range).toEqual({
      kind: "last-lines",
      count: 30,
    });
    expect(files(bash("tail -n +200 log.txt"))?.[0]?.range).toEqual({
      kind: "lines",
      first: 200,
      last: null,
    });
    expect(files(bash("tail -c 64 log.txt"))?.[0]?.range).toEqual({
      kind: "last-bytes",
      count: 64,
    });
  });

  test("tail -f never ends, so it is not a read", () => {
    expect(bash("tail -f log.txt")).toBeNull();
    expect(bash("tail -F log.txt")).toBeNull();
    expect(bash("tail --follow=name log.txt")).toBeNull();
  });

  test("sed -n with a print-only script reads its line range", () => {
    expect(files(bash("sed -n '100,250p' a.ts"))?.[0]?.range).toEqual({
      kind: "lines",
      first: 100,
      last: 250,
    });
    expect(files(bash("sed -n -e '5p' a.ts"))?.[0]?.range).toEqual({
      kind: "lines",
      first: 5,
      last: 5,
    });
    expect(files(bash("sed -ne '10,$p' a.ts"))?.[0]?.range).toEqual({
      kind: "lines",
      first: 10,
      last: null,
    });
    expect(files(bash("sed -n '/start/,/end/p' a.ts"))?.[0]?.range).toEqual({ kind: "all" });
  });

  test("sed that edits, writes, substitutes or prints everything is not a read", () => {
    expect(bash("sed -i 's/a/b/' a.ts")).toBeNull();
    expect(bash("sed -n -i '1p' a.ts")).toBeNull();
    expect(bash("sed -n '1,5w out.txt' a.ts")).toBeNull();
    expect(bash("sed -n 's/a/b/p' a.ts")).toBeNull();
    expect(bash("sed -n -f script.sed a.ts")).toBeNull();
    expect(bash("sed '1,5p' a.ts")).toBeNull();
  });

  test("less, more, bat and nl read files", () => {
    expect(files(bash("less -N a.ts"))?.[0]?.path).toBe("/repo/a.ts");
    expect(files(bash("more a.ts"))?.[0]?.path).toBe("/repo/a.ts");
    expect(files(bash("bat --style=plain --line-range 20:40 a.ts"))?.[0]).toEqual({
      path: "/repo/a.ts",
      range: { kind: "lines", first: 20, last: 40 },
    });
    expect(files(bash("nl -ba a.ts"))?.[0]?.path).toBe("/repo/a.ts");
  });

  test("less -o writes a log file, so it is not a read", () => {
    expect(bash("less -o copy.txt a.ts")).toBeNull();
  });

  test("cd then a read resolves against the new directory", () => {
    expect(files(bash("cd packages/server && cat package.json"))).toEqual([
      { path: "/repo/packages/server/package.json", range: { kind: "all" } },
    ]);
    expect(files(bash("cd ~/notes; head -5 todo.md"))?.[0]?.path).toBe(
      "/home/someone/notes/todo.md",
    );
  });

  test("a pipe into head narrows what the file loaded", () => {
    const read = bash("cat big.log | head -100");
    expect(read?.files).toEqual([{ path: "/repo/big.log", range: { kind: "all" } }]);
    expect(read?.filters).toEqual([{ kind: "lines", first: 1, last: 100 }]);
  });

  test("2>/dev/null and descriptor dups write no file", () => {
    expect(files(bash("cat a.ts 2>/dev/null"))?.[0]?.path).toBe("/repo/a.ts");
    expect(files(bash("head -20 a.ts 2>&1"))?.[0]?.path).toBe("/repo/a.ts");
  });

  test("a redirect into a file is not a read", () => {
    expect(bash("cat a.ts > b.ts")).toBeNull();
    expect(bash("head -5 a.ts >> log.txt")).toBeNull();
  });

  test("search and other commands are not reads", () => {
    expect(bash("rg foo src")).toBeNull();
    expect(bash("grep -n foo a.ts")).toBeNull();
    expect(bash("npm test")).toBeNull();
    expect(bash("ls -la")).toBeNull();
  });

  test("a read mixed with any other command is not a read", () => {
    expect(bash("cat a.ts && npm test")).toBeNull();
    expect(bash("cat a.ts; echo done")).toBeNull();
    expect(bash("grep foo a.ts | head -5")).toBeNull();
  });

  test("a command the walk cannot name, a substitution or a glob is not a read", () => {
    expect(bash("cat a.ts; $EDITOR b.ts")).toBeNull();
    expect(bash("cat $(ls src)")).toBeNull();
    expect(bash("cat src/*.ts")).toBeNull();
    expect(bash("cat a.{ts,js}")).toBeNull();
  });

  test("a line that names no file, a heredoc, or a background run is not a read", () => {
    expect(bash("cat")).toBeNull();
    expect(bash("cat <<EOF\nhello\nEOF")).toBeNull();
    expect(bash("cat a.ts", { run_in_background: true })).toBeNull();
  });

  test("wrappers are peeled", () => {
    expect(files(bash("sudo cat /etc/hosts"))?.[0]?.path).toBe("/etc/hosts");
    expect(files(bash("timeout 5 head -3 a.ts"))?.[0]?.path).toBe("/repo/a.ts");
  });

  test("the call's description is the read's why", () => {
    expect(bash("cat a.ts", { description: "Show the config loader" })?.why).toBe(
      "Show the config loader",
    );
  });
});

describe("editedPath", () => {
  test("names the file an edit tool changes", () => {
    expect(
      editedPath({
        toolName: "Edit",
        toolInput: { file_path: "/repo/a.ts" },
        cwd: CWD,
        home: HOME,
      }),
    ).toBe("/repo/a.ts");
    expect(
      editedPath({
        toolName: "NotebookEdit",
        toolInput: { notebook_path: "/repo/n.ipynb" },
        cwd: CWD,
        home: HOME,
      }),
    ).toBe("/repo/n.ipynb");
    expect(
      editedPath({
        toolName: "Read",
        toolInput: { file_path: "/repo/a.ts" },
        cwd: CWD,
        home: HOME,
      }),
    ).toBeNull();
  });
});
