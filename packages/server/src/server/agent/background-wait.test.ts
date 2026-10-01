import { describe, expect, test } from "vitest";

import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import {
  BACKGROUND_WAIT_PROMPT_MARK,
  buildBackgroundWaitPrompt,
  buildExternalWaitPrompt,
  findBackgroundShells,
  findBackgroundWait,
  findExternalWait,
  readFinalMessage,
  readFinalTurnWork,
} from "./background-wait.js";
import type { ProcessSampleRow } from "./process-sampler.js";

describe("a final message that waits on background work", () => {
  test.each([
    "Merged the base and started the gate. The full typecheck + vitest gate is running in the background (about 6 minutes); I'll report back when it finishes.",
    "Kicked off the server tests as a background shell. Waiting on it now — I'll be notified when it completes.",
    "Spawned the adversarial review subagent. Waiting on the subagent before I merge.",
    "Pushed the branch. Waiting on CI for the run.",
    "I'll continue once the build lands.",
    "I started the full gate in the background.",
    "My typecheck is still running in the background.",
    "I'll report back when the build finishes: https://ci.example.com/run?id=4",
  ])("matches: %s", (message) => {
    expect(findBackgroundWait(message)).not.toBeNull();
  });

  test("quotes the sentence that waits", () => {
    expect(
      findBackgroundWait(
        "All four files are fixed. The gate is running in the background; I'll report back when it finishes.",
      ),
    ).toEqual({
      quote: "The gate is running in the background; I'll report back when it finishes.",
    });
  });

  test.each([
    ["a finished turn", "All green. Pushed abc1234 and opened the PR. Done."],
    ["a question", "The migration is ready. Should I run it against staging?"],
    ["a question in bold", "Waiting on CI. **Merge now, or hold for the review?**"],
    [
      "a question before the last sentence of the last paragraph",
      "Waiting on the background build.\n\nShould I merge after it? It takes about ten minutes.",
    ],
    ["waiting on a person", "Waiting for your go-ahead before I push."],
    ["waiting on a confirmation", "I'll continue once you confirm the key."],
    ["background work that already finished", "The tests ran in the background and all passed."],
    [
      "background work reported done in the same sentence",
      "I started the build in the background and it already passed once.",
    ],
    [
      "a narrative about background work that is not its own",
      "The PR is up. The sweep runs in the background every five minutes.",
    ],
    ["a table row", "| Stalls (10) | restarts agents stuck waiting on background work | merged |"],
    ["a list item", "- That agent had gone idle, waiting on a build."],
    [
      "a generic noun (report)",
      "Recommend assigning it to C3 rather than waiting for it to surface as a confusing playtest report.",
    ],
    [
      "a handoff that waits on the orchestrator",
      "When you say bundle 3 has landed, I'll rebase. Then I'll run `gate:quick`, wait for them in the same turn, and report the SHA.",
    ],
    ["a generic noun (findings)", "I'm waiting for the review findings."],
    ["an empty message", "   "],
  ])("does not match %s", (_name, message) => {
    expect(findBackgroundWait(message)).toBeNull();
  });

  test("reads only the end of the message, where the next step is stated", () => {
    const message = `Waiting on the background build. ${"The rest of the summary. ".repeat(40)}`;
    expect(findBackgroundWait(message)).toBeNull();
  });
});

describe("a final message that waits on something outside the machine", () => {
  test.each([
    [
      "[#6722](https://github.com/acme/mobile/pull/6722) is up; it's waiting on CI before I merge it.",
      "CI",
    ],
    ["Pushed the branch. I'll merge once the PR checks pass.", "the PR checks"],
    ["Opened the PR. Waiting on Bugbot before I merge.", "Bugbot"],
    ["Waiting for #812 to land on main.", "#812"],
    ["Tagged the release. I'll continue after the deploy.", "the deploy"],
  ])("matches: %s", (message, target) => {
    expect(findExternalWait(message)).toMatchObject({ target });
  });

  test.each([
    ["work on the machine", "Waiting on the background build."],
    ["a review nobody named as the PR's", "I'm waiting for the review findings."],
    ["a review by a person", "Waiting for your review of the PR."],
    ["a question", "CI is still running. Merge when it is green?"],
    ["a status table", "| #6722 | waiting on CI | Tyler |"],
  ])("does not match %s", (_name, message) => {
    expect(findExternalWait(message)).toBeNull();
  });
});

let seq = 0;
function row(item: AgentTimelineItem): AgentTimelineRow {
  seq += 1;
  return { seq, timestamp: new Date(seq * 1000).toISOString(), item };
}
function tool(name: string, detail: Extract<AgentTimelineItem, { type: "tool_call" }>["detail"]) {
  return row({
    type: "tool_call",
    callId: `c${seq}`,
    name,
    detail,
    status: "completed",
    error: null,
  });
}
function bash(command: string, output?: string) {
  return tool("Bash", { type: "shell", command, ...(output ? { output } : {}) });
}
const BACKGROUND_OUTPUT =
  "Command running in background with ID: b4k2. Output is being written to: /private/tmp/claude-501/x/tasks/b4k2.output";

describe("the final message", () => {
  test("is the last assistant message when nothing came after it", () => {
    const rows = [
      row({ type: "user_message", text: "go" }),
      bash("npm test"),
      row({ type: "assistant_message", text: "Waiting on the " }),
      row({ type: "assistant_message", text: "background build." }),
    ];
    expect(readFinalMessage(rows)).toEqual({
      text: "Waiting on the background build.",
      seq: rows[3]?.seq,
    });
  });

  test("is none when a tool call or a user message came after it", () => {
    expect(
      readFinalMessage([row({ type: "assistant_message", text: "hi" }), bash("ls")]),
    ).toBeNull();
    expect(
      readFinalMessage([
        row({ type: "assistant_message", text: "hi" }),
        row({ type: "user_message", text: "continue" }),
      ]),
    ).toBeNull();
    expect(readFinalMessage([])).toBeNull();
  });
});

describe("what the final turn launched", () => {
  test("a background shell, read from Claude's answer to it", () => {
    const rows = [
      row({ type: "user_message", text: "run the gate" }),
      bash("npm run gate", BACKGROUND_OUTPUT),
      bash("git status", "clean"),
      row({ type: "assistant_message", text: "The gate is running." }),
    ];
    expect(readFinalTurnWork(rows)).toEqual({ launched: ["a background shell"], watcher: null });
  });

  test("a monitor, a workflow, a subagent and a Paseo agent", () => {
    const rows = [
      row({ type: "user_message", text: "go" }),
      tool("Monitor", { type: "unknown", input: { command: "tail -f log" }, output: null }),
      tool("Workflow", { type: "unknown", input: {}, output: null }),
      tool("Task", { type: "sub_agent", description: "review", log: "" }),
      tool("mcp__paseo__create_agent", { type: "unknown", input: {}, output: null }),
    ];
    expect(readFinalTurnWork(rows).launched).toEqual([
      "a monitor",
      "a workflow",
      "a subagent",
      "a Paseo agent",
    ]);
  });

  test("a foreground command launches nothing", () => {
    const rows = [row({ type: "user_message", text: "go" }), bash("npm test", "42 passed")];
    expect(readFinalTurnWork(rows).launched).toEqual([]);
  });

  test("work launched before the last user message is not the final turn's", () => {
    const rows = [
      bash("npm run gate", BACKGROUND_OUTPUT),
      row({ type: "user_message", text: "and now?" }),
      row({ type: "assistant_message", text: "Still waiting on the gate." }),
    ];
    expect(readFinalTurnWork(rows).launched).toEqual([]);
  });

  test("a turn a task notification started on its own belongs to the turn that launched the task", () => {
    const rows = [
      row({ type: "user_message", text: "go" }),
      bash("npm run gate", BACKGROUND_OUTPUT),
      row({ type: "assistant_message", text: "Waiting on the gate." }),
      tool("task_notification", { type: "plain_text", label: "Background task completed" }),
      row({ type: "assistant_message", text: "Gate failed; rerunning in the background." }),
    ];
    expect(readFinalTurnWork(rows).launched).toEqual(["a background shell"]);
  });

  test.each([
    ["ScheduleWakeup", "ScheduleWakeup"],
    ["mcp__paseo__create_schedule", "create_schedule"],
    ["mcp__paseo__create_heartbeat", "create_heartbeat"],
  ])("a %s is a watcher", (name, watcher) => {
    const rows = [
      row({ type: "user_message", text: "go" }),
      tool(name, { type: "unknown", input: {}, output: null }),
    ];
    expect(readFinalTurnWork(rows).watcher).toBe(watcher);
  });
});

function ps(
  pid: number,
  ppid: number,
  command: string,
  extra: Partial<ProcessSampleRow> = {},
): ProcessSampleRow {
  return { pid, ppid, uid: 501, rssKb: 1, cpuPercent: 0, etime: "01:00", command, ...extra };
}

function pids(rows: readonly ProcessSampleRow[]): number[] {
  return rows.map((entry) => entry.pid);
}

describe("background shells under an agent", () => {
  const root = ps(
    100,
    1,
    "/Users/x/.local/share/claude/versions/2.1 --mcp-config http://h/mcp?callerAgentId=a1",
  );

  test("a zombie or a non-shell child is not background work", () => {
    expect(
      findBackgroundShells(
        [root, ps(101, 100, "<defunct>"), ps(102, 100, "node mcp-server.js")],
        100,
      ),
    ).toEqual([]);
  });

  test("a live shell is, however deep", () => {
    const shell = ps(
      103,
      100,
      "/bin/zsh -c source ~/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'npm test'",
    );
    const nested = ps(105, 104, "bash -lc make");
    const found = findBackgroundShells(
      [root, shell, ps(104, 100, "node runner.js"), nested, ps(106, 103, "node vitest")],
      100,
    );
    expect(found.map((entry) => entry.pid).sort()).toEqual([103, 105]);
  });

  test("a login shell counts", () => {
    expect(findBackgroundShells([root, ps(107, 100, "-zsh")], 100)).toHaveLength(1);
  });

  test("a shell is told by its executable, not by a word in its arguments", () => {
    expect(findBackgroundShells([root, ps(108, 100, "node build.js --shell bash")], 100)).toEqual(
      [],
    );
  });

  describe("on Windows", () => {
    const winRoot = ps(
      300,
      1,
      '"C:\\Program Files\\nodejs\\node.exe" claude.js --mcp-config http://h/mcp?callerAgentId=a1',
    );

    test.each([
      ["cmd.exe", "C:\\Windows\\System32\\cmd.exe /c npm test"],
      [
        "Git Bash under a quoted path with spaces",
        '"C:\\Program Files\\Git\\bin\\bash.exe" -c "npm test"',
      ],
      [
        "Git Bash under an unquoted path with spaces",
        'C:\\Program Files\\Git\\usr\\bin\\bash.exe -c "npm test"',
      ],
      [
        "PowerShell 7",
        '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command "npm test"',
      ],
    ])("%s counts", (_name, command) => {
      expect(findBackgroundShells([winRoot, ps(301, 300, command)], 300)).toHaveLength(1);
    });

    test("the sampler's image name decides over the command line", () => {
      const shell = ps(302, 300, '"C:\\Program Files\\Git\\bin\\bash.exe" -c "npm test"', {
        name: "bash.exe",
      });
      const notShell = ps(303, 300, "bash.exe -c npm test", { name: "node.exe" });
      expect(pids(findBackgroundShells([winRoot, shell, notShell], 300))).toEqual([302]);
    });

    test("a program under a path with spaces is not a shell", () => {
      expect(
        findBackgroundShells(
          [winRoot, ps(304, 300, "C:\\Program Files\\Java\\bin\\java.exe -jar gradle.jar")],
          300,
        ),
      ).toEqual([]);
    });
  });

  test("shells outside the agent's tree are not its", () => {
    expect(findBackgroundShells([root, ps(200, 1, "/bin/zsh -c sleep 600")], 100)).toEqual([]);
  });
});

describe("the prompts", () => {
  test("own work names what the turn launched and asks for the result", () => {
    const prompt = buildBackgroundWaitPrompt({
      quietForMs: 12 * 60_000,
      quote: "The gate is running in the background.",
      launched: ["a background shell", "a subagent"],
    });
    expect(prompt).toContain(
      'Your last turn started background work (a background shell, a subagent) and ended 12 minutes ago saying: "The gate is running in the background."',
    );
    expect(prompt).toContain("Check the result of that work");
    expect(BACKGROUND_WAIT_PROMPT_MARK.test(prompt)).toBe(true);
  });

  test("an external wait says nothing is watching it", () => {
    const prompt = buildExternalWaitPrompt({
      quietForMs: 16 * 60_000,
      quote: "it's waiting on CI before I merge it.",
      target: "CI",
    });
    expect(prompt).toContain(
      'Your last turn ended 16 minutes ago saying you were waiting on CI: "it\'s waiting on CI before I merge it."',
    );
    expect(prompt).toContain("Nothing is watching CI");
    expect(prompt).toContain("set up a watcher");
    expect(BACKGROUND_WAIT_PROMPT_MARK.test(prompt)).toBe(true);
  });
});
