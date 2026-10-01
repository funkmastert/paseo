import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resolveJevConfig } from "../config.js";
import type {
  JevFileReadEvent,
  JevNotAskedReason,
  JevSavingsInput,
  JevSavingsSink,
  JevSavingsValidation,
} from "../contract.js";
import {
  createTestJevService,
  type JevScriptedAnswer,
  type TestJevServiceOptions,
} from "../fake.js";
import {
  ReadCheckObserver,
  type ReadCheckAgentSource,
  type ReadCheckFileSystem,
} from "./observer.js";
import type { ReadCheckTimelineRow } from "./validation.js";

const AGENT = "agent-read-1";
const NOT_NEEDED: Record<string, JevScriptedAnswer> = {
  need: { type: "choice", choice: "not_needed", confidence: 0.91 },
};
const QUOTE = "export function resolveSessionToken(request: SessionRequest): string {";

class RecordingSavings implements JevSavingsSink {
  records: JevSavingsInput[] = [];
  settles: Array<{ id: string; facts: Record<string, unknown> }> = [];
  validations: Array<{ id: string; validation: JevSavingsValidation }> = [];
  notAsked: JevNotAskedReason[] = [];
  reads: JevFileReadEvent[] = [];
  record(input: JevSavingsInput): string {
    this.records.push(input);
    return `sv_${this.records.length}`;
  }
  settle(id: string, facts: Record<string, string | number | boolean | null>): void {
    this.settles.push({ id, facts });
  }
  validate(id: string, validation: JevSavingsValidation): void {
    this.validations.push({ id, validation });
  }
  countNotAsked(_feature: string, reason: JevNotAskedReason): void {
    this.notAsked.push(reason);
  }
  noteRead(event: JevFileReadEvent): void {
    this.reads.push(event);
  }
}

let root: string;
let repo: string;
let paseoHome: string;
let rows: ReadCheckTimelineRow[];

/** About 5,600 tokens as Read loads it: over the 2,000 floor. */
function bigSource(): string {
  const lines = ['import { createHash } from "node:crypto";', QUOTE];
  for (let index = 0; index < 300; index += 1) {
    lines.push(`  const value${index} = computeSomethingUseful(${index}, "padding");`);
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function writeRepoFile(relative: string, content: string): string {
  const full = path.join(repo, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

function agentSource(): ReadCheckAgentSource {
  return {
    agent: () => ({
      title: "Fix the login bug",
      cwd: repo,
      model: "claude-opus-5-5",
      workspaceId: "ws-1",
      labels: {},
      contextTokens: 60_000,
    }),
    assignment: () => "Find out why the login form rejects valid passwords and fix it.",
    tail: (_agentId, limit) => ({ epoch: "e1", rows: rows.slice(-limit) }),
    after: (_agentId, cursor, limit) => ({
      epoch: "e1",
      rows: rows.filter((row) => row.seq > cursor.seq).slice(0, limit),
    }),
  };
}

function setup(
  options: {
    config?: Record<string, unknown>;
    answers?: Record<string, JevScriptedAnswer>;
    behavior?: TestJevServiceOptions["behavior"];
    fs?: ReadCheckFileSystem;
  } = {},
) {
  const config = options.config ?? {};
  const jev = createTestJevService({
    paseoHome,
    homeDir: root,
    config,
    answers: options.answers ?? NOT_NEEDED,
    behavior: options.behavior,
    service: { resolveAgentCwds: async () => [repo] },
  });
  const savings = new RecordingSavings();
  const resolved = resolveJevConfig(config, { homeDir: root });
  const observer = new ReadCheckObserver({
    jev,
    savings,
    readConfig: () => (resolved.enabled ? resolved.readCheck : null),
    agents: agentSource(),
    homeDir: root,
    paseoHome,
    logger: pino({ level: "silent" }),
    sweepIntervalMs: 0,
    ...(options.fs ? { fs: options.fs } : {}),
  });
  return { jev, savings, observer };
}

let toolUseCounter = 0;

function readPost(filePath: string, content: string, extra: Record<string, unknown> = {}) {
  const lines = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
  const toolUseId = `toolu_${++toolUseCounter}`;
  rows.push({
    seq: rows.length + 1,
    timestamp: new Date().toISOString(),
    turnId: "turn-1",
    item: {
      type: "tool_call",
      callId: toolUseId,
      name: "Read",
      status: "completed",
      error: null,
      detail: { type: "read", filePath },
    },
  });
  return {
    agentId: AGENT,
    agentCwd: repo,
    input: {
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: filePath },
      tool_use_id: toolUseId,
      cwd: repo,
      tool_response: {
        type: "text",
        file: { filePath, content, numLines: lines, startLine: 1, totalLines: lines },
      },
      ...extra,
    },
  };
}

function bashPost(command: string, stdout: string) {
  return {
    agentId: AGENT,
    agentCwd: repo,
    input: {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command, description: "Show the file" },
      tool_use_id: `toolu_${++toolUseCounter}`,
      cwd: repo,
      tool_response: { stdout, stderr: "", interrupted: false },
    },
  };
}

function pre(toolName: string, toolInput: Record<string, unknown>) {
  return {
    agentId: AGENT,
    agentCwd: repo,
    input: {
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: `toolu_${++toolUseCounter}`,
      cwd: repo,
    },
  };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "read-check-")));
  repo = path.join(root, "projects", "app");
  paseoHome = path.join(root, ".paseo");
  mkdirSync(repo, { recursive: true });
  mkdirSync(paseoHome, { recursive: true });
  rows = [
    {
      seq: 0,
      timestamp: new Date().toISOString(),
      turnId: "turn-1",
      item: { type: "assistant_message", text: "I will look at the session module next." },
    },
  ];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ReadCheckObserver: shadow, the default", () => {
  test("PreToolUse answers in the same tick and queues nothing for a read", () => {
    const { observer, jev } = setup({ behavior: { kind: "hold" } });
    const file = writeRepoFile("src/session.ts", bigSource());
    expect(observer.preToolUse(pre("Read", { file_path: file }))).toBeNull();
    expect(jev.transport.calls).toEqual([]);
  });

  test("a large read is judged after it ran, with the state as specified", async () => {
    const { observer, jev, savings } = setup();
    const content = bigSource();
    const file = writeRepoFile("src/session.ts", content);
    observer.postToolUse(readPost(file, content));
    expect(jev.transport.calls).toEqual([]);
    await observer.idle();

    expect(jev.transport.calls).toHaveLength(1);
    const state = jev.transport.calls[0]!.state as Record<string, unknown>;
    expect(state["task"]).toBe(
      "Fix the login bug\nFind out why the login form rejects valid passwords and fix it.",
    );
    expect(state["recent"]).toEqual(["assistant: I will look at the session module next."]);
    expect(state["path"]).toBe("src/session.ts");
    expect(state["size"]).toMatch(/^all 303 lines, about [\d,]+ tokens$/);
    expect(String(state["outline"])).toContain(QUOTE);
    expect(String(state["excerpt"]).length).toBe(6000);
    expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThanOrEqual(10_000);

    expect(savings.records).toHaveLength(1);
    expect(savings.records[0]).toMatchObject({
      feature: "readCheck",
      callSite: "read-check.shadow",
      agentId: AGENT,
      workspaceId: "ws-1",
      involvement: "Does this agent need src/session.ts?",
      decision: { did: "read", wouldBe: "skip", changed: false },
      pending: true,
    });
    expect(savings.records[0]!.facts["contextTokens"]).toBeGreaterThan(2000);
    expect(savings.records[0]!.facts["estimated"]).toBe(false);
    expect(savings.reads).toEqual([
      expect.objectContaining({ agentId: AGENT, path: file, tool: "Read" }),
    ]);
  });

  test("a live feature still answers shadow for the control arm", async () => {
    const { observer, jev, savings } = setup({
      config: { readCheck: { shadow: false, liveShare: 0 } },
    });
    const content = bigSource();
    const file = writeRepoFile("src/session.ts", content);
    expect(observer.preToolUse(pre("Read", { file_path: file }))).toBeNull();
    observer.postToolUse(readPost(file, content));
    await observer.idle();
    expect(jev.transport.calls).toHaveLength(1);
    // The call site is the outcome's: a shadow answer, though the feature is live.
    expect(savings.records[0]!.callSite).toBe("read-check.shadow");
  });

  describe("not asked, each reason in order", () => {
    test("inactive: the feature is off", async () => {
      const { observer, jev, savings } = setup({ config: { readCheck: { enabled: false } } });
      const content = bigSource();
      observer.postToolUse(readPost(writeRepoFile("a.ts", content), content));
      await observer.idle();
      expect(savings.notAsked).toEqual(["inactive"]);
      expect(jev.transport.calls).toEqual([]);
    });

    test("below-floor: under 2,000 tokens, still noted as a read", async () => {
      const { observer, savings } = setup();
      const content = "export const small = 1;\n";
      observer.postToolUse(readPost(writeRepoFile("small.ts", content), content));
      await observer.idle();
      expect(savings.notAsked).toEqual(["below-floor"]);
      expect(savings.reads).toHaveLength(1);
    });

    test("not-text and dedup", async () => {
      const { observer, savings } = setup();
      const image = writeRepoFile("shot.png", "x");
      observer.postToolUse({
        agentId: AGENT,
        agentCwd: repo,
        input: {
          tool_name: "Read",
          tool_input: { file_path: image },
          tool_use_id: "toolu_img",
          tool_response: { type: "image", file: { base64: "", type: "image/png" } },
        },
      });
      observer.postToolUse({
        agentId: AGENT,
        agentCwd: repo,
        input: {
          tool_name: "Read",
          tool_input: { file_path: writeRepoFile("same.ts", "x") },
          tool_use_id: "toolu_same",
          tool_response: { type: "file_unchanged", file: { filePath: "same.ts" } },
        },
      });
      await observer.idle();
      expect(savings.notAsked.sort()).toEqual(["dedup", "not-text"]);
    });

    test("outside-cwd and secret-path", async () => {
      const { observer, savings, jev } = setup();
      const content = bigSource();
      const outside = path.join(root, "elsewhere.ts");
      writeFileSync(outside, content);
      observer.postToolUse(readPost(outside, content));
      observer.postToolUse(readPost(writeRepoFile(".env.production", content), content));
      await observer.idle();
      expect(savings.notAsked.sort()).toEqual(["outside-cwd", "secret-path"]);
      expect(jev.transport.calls).toEqual([]);
    });

    test("excluded (D7): nothing is sent and the file is never opened", async () => {
      const readFile = vi.fn<ReadCheckFileSystem["readFile"]>();
      const { observer, savings, jev } = setup({
        config: { excludeCwds: [repo] },
        fs: { realpath: async (p) => p, readFile },
      });
      const content = bigSource();
      writeRepoFile("a.ts", content);
      writeRepoFile("b.ts", content);
      // Two files: the observer would read each from disk, if scope allowed it.
      observer.postToolUse(bashPost("cat a.ts b.ts", content + content));
      await observer.idle();
      expect(savings.notAsked).toEqual(["excluded", "excluded"]);
      expect(readFile).not.toHaveBeenCalled();
      expect(jev.transport.calls).toEqual([]);
    });

    test("repeat: the same agent, path and range within 30 minutes makes no call", async () => {
      const { observer, savings, jev } = setup({
        answers: { need: { type: "choice", choice: "needed", confidence: 0.9 } },
      });
      const content = bigSource();
      const file = writeRepoFile("src/session.ts", content);
      observer.postToolUse(readPost(file, content));
      await observer.idle();
      observer.postToolUse(readPost(file, content));
      await observer.idle();
      expect(jev.transport.calls).toHaveLength(1);
      expect(savings.notAsked).toEqual(["repeat"]);
      expect(savings.records).toHaveLength(1);
    });
  });

  test("recent lists each earlier tool call once, and never the read itself", async () => {
    const { observer, jev } = setup();
    const content = bigSource();
    const file = writeRepoFile("src/session.ts", content);
    const call = (status: "running" | "completed", detail: Record<string, unknown>) => ({
      seq: rows.length + 1,
      timestamp: new Date().toISOString(),
      turnId: "turn-1",
      item: {
        type: "tool_call" as const,
        callId: "toolu_grep",
        name: "Grep",
        status,
        error: null,
        detail,
      },
    });
    rows.push(
      call("running", { type: "unknown", input: null, output: null }) as ReadCheckTimelineRow,
    );
    rows.push(
      call("completed", { type: "search", query: "resolveSessionToken" }) as ReadCheckTimelineRow,
    );
    observer.postToolUse(readPost(file, content));
    await observer.idle();
    expect((jev.transport.calls[0]!.state as Record<string, unknown>)["recent"]).toEqual([
      "assistant: I will look at the session module next.",
      "tool Grep resolveSessionToken",
    ]);
  });

  test("a Bash read is measured from its output and keeps its description", async () => {
    const { observer, jev, savings } = setup();
    const content = bigSource();
    writeRepoFile("src/session.ts", content);
    observer.postToolUse(bashPost("cat src/session.ts", content));
    await observer.idle();
    const state = jev.transport.calls[0]!.state as Record<string, unknown>;
    expect(state["why"]).toBe("Show the file");
    expect(savings.records[0]!.facts["tool"]).toBe("Bash");
    expect(savings.records[0]!.facts["contextTokens"]).toBe(Math.round(content.length / 2.35));
  });

  test("a read inside a subagent is judged for the parent and says so", async () => {
    const { observer, savings } = setup();
    const content = bigSource();
    const file = writeRepoFile("src/session.ts", content);
    observer.postToolUse(readPost(file, content, { agent_id: "sub-1" }));
    await observer.idle();
    expect(savings.records[0]!.facts["subagent"]).toBe(true);
  });
});

describe("ReadCheckObserver: did the agent use it", () => {
  async function skipped() {
    const harness = setup();
    const content = bigSource();
    const file = writeRepoFile("src/session.ts", content);
    harness.observer.postToolUse(readPost(file, content));
    await harness.observer.idle();
    expect(harness.savings.records[0]!.decision.wouldBe).toBe("skip");
    return { ...harness, file, content };
  }

  test("an edit of the path is a false skip", async () => {
    const { observer, savings, file } = await skipped();
    expect(
      observer.preToolUse(pre("Edit", { file_path: file, old_string: "a", new_string: "b" })),
    ).toBeNull();
    await observer.idle();
    expect(savings.validations).toEqual([
      {
        id: "sv_1",
        validation: expect.objectContaining({ outcome: "false-skip", signal: "edited" }),
      },
    ]);
  });

  test("reading the path again is a false skip", async () => {
    const { observer, savings, file, content } = await skipped();
    observer.postToolUse(bashPost("sed -n '1,20p' src/session.ts", content.slice(0, 500)));
    await observer.idle();
    expect(savings.validations[0]!.validation).toMatchObject({
      outcome: "false-skip",
      signal: "reread",
    });
    expect(file).toContain("session.ts");
  });

  test("quoting a line of the file in a later message is a false skip", async () => {
    const { observer, savings } = await skipped();
    rows.push({
      seq: rows.length + 1,
      timestamp: new Date(Date.now() + 1000).toISOString(),
      turnId: "turn-1",
      item: { type: "assistant_message", text: `The culprit is:\n${QUOTE}` },
    });
    await observer.sweep();
    expect(savings.validations[0]!.validation).toMatchObject({
      outcome: "false-skip",
      signal: "quoted",
    });
  });

  test("with no sign by the end of the window, the verdict held", async () => {
    const { observer, savings } = await skipped();
    for (const turnId of ["turn-2", "turn-3", "turn-4"]) {
      rows.push({
        seq: rows.length + 1,
        timestamp: new Date(Date.now() + 1000).toISOString(),
        turnId,
        item: { type: "assistant_message", text: "Working on the form validation instead." },
      });
    }
    await observer.sweep();
    expect(savings.validations).toEqual([
      { id: "sv_1", validation: { outcome: "held", signal: null, afterMinutes: null } },
    ]);
  });
});

describe("ReadCheckObserver: live mode (D11)", () => {
  const LIVE = {
    readCheck: { shadow: false, liveShare: 1, liveMinTokens: 3000, liveTimeoutMs: 1000 },
  };

  test("denies a large not-needed read once; the second read goes through unchecked", async () => {
    const { observer, savings, jev } = setup({ config: LIVE });
    const content = bigSource();
    const file = writeRepoFile("src/session.ts", content);
    const hold = observer.preToolUse(pre("Read", { file_path: file }));
    expect(hold?.timeoutMs).toBe(1000);
    const verdict = await hold!.verdict;
    expect(verdict?.denyReason).toMatch(
      /^JEV judged src\/session\.ts \(about [\d,]+ tokens\) not needed for your task \(0\.91\)\. If you need it, run the same Read again; it goes through without a check\.$/,
    );
    expect(savings.records[0]).toMatchObject({
      callSite: "read-check.live",
      decision: { did: "deny", wouldBe: "deny", changed: true },
      pending: true,
    });
    expect(savings.records[0]!.facts["estimated"]).toBe(true);
    expect(jev.listDecisions(AGENT)[0]).toMatchObject({ feature: "readCheck", applied: true });

    // The retry: no hold, no call, and it is the deny's regret.
    const retry = pre("Read", { file_path: file });
    expect(observer.preToolUse(retry)).toBeNull();
    observer.postToolUse({
      ...readPost(file, content),
      input: { ...readPost(file, content).input, tool_use_id: retry.input.tool_use_id },
    });
    await observer.idle();
    expect(jev.transport.calls).toHaveLength(1);
    expect(savings.validations[0]!.validation).toMatchObject({
      outcome: "regret",
      signal: "reread",
    });
  });

  test("a needed answer lets the read run, and its PostToolUse settles the measurement", async () => {
    const { observer, savings } = setup({
      config: LIVE,
      answers: { need: { type: "choice", choice: "needed", confidence: 0.95 } },
    });
    const content = bigSource();
    const file = writeRepoFile("src/session.ts", content);
    const event = pre("Read", { file_path: file });
    const hold = observer.preToolUse(event);
    expect(await hold!.verdict).toBeNull();
    const post = readPost(file, content);
    observer.postToolUse({
      ...post,
      input: { ...post.input, tool_use_id: event.input.tool_use_id },
    });
    await observer.idle();
    expect(savings.records).toHaveLength(1);
    expect(savings.records[0]!.decision).toMatchObject({ did: "read", changed: false });
    expect(savings.settles).toEqual([
      { id: "sv_1", facts: expect.objectContaining({ estimated: false }) },
    ]);
  });

  test("past liveTimeoutMs the read runs, and a late deny is never given", async () => {
    const { observer, savings, jev } = setup({
      config: { readCheck: { ...LIVE.readCheck, liveTimeoutMs: 300 } },
      behavior: { kind: "hold" },
    });
    const content = bigSource();
    const file = writeRepoFile("src/session.ts", content);
    const startedAt = Date.now();
    const hold = observer.preToolUse(pre("Read", { file_path: file }));
    expect(await hold!.verdict).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(1000);
    jev.transport.release();
    await observer.idle();
    expect(savings.records.every((record) => record.decision.did !== "deny")).toBe(true);
  });

  test("small reads, edited paths and agents outside the share are not held", async () => {
    const { observer } = setup({ config: LIVE });
    const small = writeRepoFile("small.ts", "export const x = 1;\n");
    const hold = observer.preToolUse(pre("Read", { file_path: small }));
    expect(await hold!.verdict).toBeNull();

    const big = writeRepoFile("big.ts", bigSource());
    observer.preToolUse(pre("Write", { file_path: big, content: "x" }));
    await observer.idle();
    expect(observer.preToolUse(pre("Read", { file_path: big }))).toBeNull();

    const outside = setup({ config: { readCheck: { ...LIVE.readCheck, liveShare: 0 } } });
    expect(outside.observer.preToolUse(pre("Read", { file_path: big }))).toBeNull();
  });
});
