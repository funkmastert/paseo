import { describe, expect, test } from "vitest";

import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import {
  buildBackgroundWaitPrompt,
  findBackgroundShells,
  findBackgroundWait,
  readFinalMessage,
} from "./background-wait.js";
import type { ProcessSampleRow } from "./process-sampler.js";

describe("a final message that waits on background work", () => {
  // Shaped on the three agents that stalled this way on 2026-09-29: each ended its turn saying it
  // was waiting on work it had started in the background, and nothing woke it.
  test.each([
    "Merged the base and started the gate. The full typecheck + vitest gate is running in the background (about 6 minutes); I'll report back when it finishes.",
    "Kicked off the server tests as a background shell. Waiting on it now — I'll be notified when it completes.",
    "Spawned the adversarial review subagent. Waiting for its findings before I merge.",
    "Pushed the branch. Waiting on CI for the run.",
    "I'll continue once the build lands.",
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
    ["waiting on a person", "Waiting for your go-ahead before I push."],
    ["waiting on a confirmation", "I'll continue once you confirm the key."],
    ["background work that already finished", "The tests ran in the background and all passed."],
    [
      "background work reported done in the same sentence",
      "The build is running in the background and it already passed once.",
    ],
    ["an empty message", "   "],
  ])("does not match %s", (_name, message) => {
    expect(findBackgroundWait(message)).toBeNull();
  });

  test("reads only the end of the message, where the next step is stated", () => {
    const message = `Waiting on the background build. ${"The rest of the summary. ".repeat(40)}`;
    expect(findBackgroundWait(message)).toBeNull();
  });
});

let seq = 0;
function row(item: AgentTimelineItem): AgentTimelineRow {
  seq += 1;
  return { seq, timestamp: new Date(seq * 1000).toISOString(), item };
}

describe("the final message", () => {
  test("is the last assistant message when nothing came after it", () => {
    const rows = [
      row({ type: "user_message", text: "go" }),
      row({
        type: "tool_call",
        callId: "c1",
        name: "Bash",
        detail: { type: "shell", command: "npm test" },
        status: "completed",
        error: null,
      }),
      row({ type: "assistant_message", text: "Waiting on the " }),
      row({ type: "assistant_message", text: "background build." }),
    ];
    expect(readFinalMessage(rows)).toEqual({
      text: "Waiting on the background build.",
      seq: rows[3]?.seq,
    });
  });

  test("is none when a tool call or a user message came after it", () => {
    const tool = row({
      type: "tool_call",
      callId: "c2",
      name: "Bash",
      detail: { type: "shell", command: "ls" },
      status: "completed",
      error: null,
    });
    expect(readFinalMessage([row({ type: "assistant_message", text: "hi" }), tool])).toBeNull();
    expect(
      readFinalMessage([
        row({ type: "assistant_message", text: "hi" }),
        row({ type: "user_message", text: "continue" }),
      ]),
    ).toBeNull();
    expect(readFinalMessage([])).toBeNull();
  });
});

function ps(pid: number, ppid: number, command: string): ProcessSampleRow {
  return { pid, ppid, uid: 501, rssKb: 1, cpuPercent: 0, etime: "01:00", command };
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

  test("a login shell and a Windows shell count", () => {
    expect(findBackgroundShells([root, ps(107, 100, "-zsh")], 100)).toHaveLength(1);
    expect(
      findBackgroundShells([root, ps(108, 100, "C:\\Windows\\System32\\cmd.exe /c npm test")], 100),
    ).toHaveLength(1);
  });

  test("no root process means nothing is running", () => {
    expect(findBackgroundShells([root], undefined)).toEqual([]);
  });

  test("shells outside the agent's tree are not its", () => {
    expect(findBackgroundShells([root, ps(200, 1, "/bin/zsh -c sleep 600")], 100)).toEqual([]);
  });
});

test("the prompt quotes the wait and says why it was sent", () => {
  const prompt = buildBackgroundWaitPrompt({ quietForMs: 12 * 60_000, quote: "Waiting on CI." });
  expect(prompt).toContain(
    '12 minutes ago saying you were waiting on background work: "Waiting on CI."',
  );
  expect(prompt).toContain("Nothing wakes an idle agent when background work finishes");
  expect(prompt).toContain("wait for it in the foreground");
});
