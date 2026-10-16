import { describe, expect, test } from "vitest";

import { TypedTerminalLines } from "./typed-terminal-lines.js";

describe("TypedTerminalLines", () => {
  test("returns a line when it is submitted, across separate sends", () => {
    const lines = new TypedTerminalLines();

    expect(lines.feed("t1", "rm -rf ")).toEqual([]);
    expect(lines.feed("t1", "~")).toEqual([]);
    expect(lines.feed("t1", "\r")).toEqual(["rm -rf ~"]);
    expect(lines.feed("t1", "ls\npwd\r")).toEqual(["ls", "pwd"]);
  });

  test("keeps terminals apart and follows backspace, Ctrl-C and Ctrl-U", () => {
    const lines = new TypedTerminalLines();

    lines.feed("t1", "rm -rf ~");
    lines.feed("t2", "ls");
    expect(lines.feed("t1", "\u007f/tmp\r")).toEqual(["rm -rf /tmp"]);
    expect(lines.feed("t2", "\u0003echo hi\r")).toEqual(["echo hi"]);
    lines.feed("t2", "rm -rf /");
    expect(lines.feed("t2", "\u0015ls\r")).toEqual(["ls"]);
  });

  test("gives up on a line it cannot reconstruct, rather than guessing", () => {
    const lines = new TypedTerminalLines();

    // Tab completion or history recall changes the line in ways only the shell knows.
    lines.feed("t1", "rm -rf ~/co\t");
    expect(lines.feed("t1", "\r")).toEqual([]);
    lines.feed("t1", "\u001b[A");
    expect(lines.feed("t1", "\r")).toEqual([]);
    // The next line starts clean.
    expect(lines.feed("t1", "pwd\r")).toEqual(["pwd"]);
  });

  test("submits a heredoc typed line by line as one script, when its delimiter arrives", () => {
    const lines = new TypedTerminalLines();

    expect(lines.feed("t1", "cat > wipe.sh <<'EOF'\r")).toEqual([]);
    expect(lines.feed("t1", "rm -rf /\r")).toEqual([]);
    expect(lines.feed("t1", "EOF\r")).toEqual(["cat > wipe.sh <<'EOF'\nrm -rf /\nEOF"]);
    expect(lines.feed("t1", "rm -rf ~\r")).toEqual(["rm -rf ~"]);
    // Ctrl-D ends a heredoc too, and the shell runs it.
    lines.feed("t1", "bash <<EOF\rrm -rf /\r");
    expect(lines.feed("t1", "\u0004")).toEqual(["bash <<EOF\nrm -rf /"]);
  });

  test("keeps the typed text when told a submitted line was refused", () => {
    const lines = new TypedTerminalLines();

    lines.feed("t1", "rm -rf ~");
    const snapshot = lines.snapshot("t1");
    expect(lines.feed("t1", "\r")).toEqual(["rm -rf ~"]);
    lines.restore("t1", snapshot);
    // The text is still sitting at the prompt, so another Enter submits it again.
    expect(lines.feed("t1", "\r")).toEqual(["rm -rf ~"]);
  });
});
