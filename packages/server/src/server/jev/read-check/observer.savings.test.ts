import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, expect, test } from "vitest";

import { resolveJevConfig } from "../config.js";
import { createTestJevService } from "../fake.js";
import { ReadCheckObserver } from "./observer.js";
import type { ReadCheckTimelineRow } from "./validation.js";
import { initGitRepo } from "../test-utils/git-repo.js";

/** The observer over the service's real savings ledger, not a recording double. */

let root: string;
let repo: string;
let paseoHome: string;
let rows: ReadCheckTimelineRow[];

/** About 11,000 tokens as Read loads it: over live's 8,000, which the evidence rule counts. */
function bigSource(): string {
  const lines = ["export function resolveSessionToken(request: SessionRequest): string {"];
  for (let index = 0; index < 400; index += 1) {
    lines.push(`  const value${index} = computeSomethingUseful(${index}, "padding");`);
  }
  return `${lines.join("\n")}\n`;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "read-check-savings-")));
  repo = path.join(root, "projects", "app");
  paseoHome = path.join(root, ".paseo");
  initGitRepo(repo);
  mkdirSync(paseoHome, { recursive: true });
  rows = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("a shadow would-skip that held lands in the ledger as feature 16's evidence", async () => {
  const jev = createTestJevService({
    paseoHome,
    homeDir: root,
    config: {},
    answers: { need: { type: "choice", choice: "not_needed", confidence: 0.91 } },
    service: { resolveAgentCwds: async () => [repo] },
  });
  // The daemon starts the service at boot; the ledger counts nothing before it has loaded.
  await jev.start();
  const resolved = resolveJevConfig({}, { homeDir: root });
  const observer = new ReadCheckObserver({
    jev,
    savings: jev.savings,
    readConfig: () => resolved.readCheck,
    agents: {
      agent: () => ({
        title: "Fix the login bug",
        cwd: repo,
        model: "claude-opus-5-5",
        workspaceId: "ws-1",
        labels: {},
        contextTokens: 60_000,
      }),
      assignment: () => "Fix the login form.",
      tail: (_agentId, limit) => ({ epoch: "e1", rows: rows.slice(-limit) }),
      after: (_agentId, cursor, limit) => ({
        epoch: "e1",
        rows: rows.filter((row) => row.seq > cursor.seq).slice(0, limit),
      }),
    },
    homeDir: root,
    paseoHome,
    logger: pino({ level: "silent" }),
    sweepIntervalMs: 0,
  });

  const content = bigSource();
  const file = path.join(repo, "src", "session.ts");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  const lines = content.split("\n").length - 1;
  observer.postToolUse({
    agentId: "agent-1",
    agentCwd: repo,
    input: {
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: file },
      tool_use_id: "toolu_1",
      cwd: repo,
      tool_response: {
        type: "text",
        file: { filePath: file, content, numLines: lines, startLine: 1, totalLines: lines },
      },
    },
  });
  // A compound line of another file: counted by reason in the same ledger.
  observer.postToolUse({
    agentId: "agent-1",
    agentCwd: repo,
    input: {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "cat src/other.ts; cat < .env" },
      tool_use_id: "toolu_2",
      cwd: repo,
      tool_response: { stdout: content, stderr: "", interrupted: false },
    },
  });
  await observer.idle();

  // Three later turns with no use of the file: the window closes as held.
  for (const turnId of ["turn-2", "turn-3", "turn-4", "turn-5"]) {
    rows.push({
      seq: rows.length + 1,
      timestamp: new Date(Date.now() + 1000).toISOString(),
      turnId,
      item: { type: "assistant_message", text: "Working on the form validation instead." },
    });
  }
  await observer.sweep();
  await observer.stop();

  const feature = jev.savings.summary("today").features.find((f) => f.feature === "readCheck");
  expect(feature).toMatchObject({ asked: 1, notAsked: { compound: 1 } });
  expect(feature!.shadow.involvements).toBe(1);
  expect(feature!.shadow.tokens).toBeGreaterThan(0);
  expect(feature!.validation).toMatchObject({ checked: 1, held: 1, wrong: 0 });
  expect(feature!.evidence.observed).toMatch(/^1 would-skips, 0% false/);
  await jev.stop();
});
