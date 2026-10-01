import { describe, expect, test } from "vitest";

import { walkShellCommands } from "./shell-commands.js";

function walk(script: string, withUnresolved: boolean) {
  const commands: string[] = [];
  let unresolved = 0;
  walkShellCommands(
    script,
    { cwd: "/repo", home: "/home/someone" },
    {
      command(args) {
        commands.push(args.map((arg) => arg.text).join(" "));
        return false;
      },
      outputRedirect: () => false,
      ...(withUnresolved
        ? {
            unresolvedCommand: () => {
              unresolved += 1;
              return false;
            },
          }
        : {}),
    },
  );
  return { commands, unresolved };
}

describe("walkShellCommands: unresolvedCommand", () => {
  test("reports a command whose name the walk cannot know", () => {
    expect(walk("cat a.ts; $EDITOR b.ts", true)).toEqual({ commands: ["cat a.ts"], unresolved: 1 });
    expect(walk("$(which cat) a.ts", true).unresolved).toBe(1);
  });

  test("absent, such commands are skipped as before", () => {
    expect(walk("cat a.ts; $EDITOR b.ts", false)).toEqual({
      commands: ["cat a.ts"],
      unresolved: 0,
    });
  });

  test("a known variable names its command, and stops nothing", () => {
    expect(walk("X=cat; $X a.ts", true)).toEqual({ commands: ["cat a.ts"], unresolved: 0 });
  });

  test("returning true stops the walk", () => {
    const commands: string[] = [];
    walkShellCommands(
      "$EDITOR a.ts; rm -rf b",
      { cwd: "/repo", home: null },
      {
        command(args) {
          commands.push(args[0]!.text);
          return false;
        },
        outputRedirect: () => false,
        unresolvedCommand: () => true,
      },
    );
    expect(commands).toEqual([]);
  });
});
