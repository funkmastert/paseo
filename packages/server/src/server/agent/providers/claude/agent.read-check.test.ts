import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { Query } from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resolveJevConfig } from "../../../jev/config.js";
import type { JevSavingsSink } from "../../../jev/contract.js";
import {
  createTestJevService,
  withJevTransportDelay,
  createFakeJevTransport,
} from "../../../jev/fake.js";
import {
  ReadCheckObserver,
  type FileReadHold,
  type FileReadObserver,
} from "../../../jev/read-check/observer.js";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeQueryInput } from "./query.js";

/**
 * Feature 16 at the Claude provider's seam (docs/jev.md, "Feature 16"): which matchers are
 * registered, that a shadow callback answers before the observer's work starts, that the gates
 * keep their matchers, and the latency a Read pays with the hooks on, measured against JEV slowed
 * to 2 seconds.
 */

function createQueryMock(): Query {
  const events = [
    {
      type: "system",
      subtype: "init",
      session_id: "read-check-session",
      permissionMode: "bypassPermissions",
      model: "opus",
    },
    { type: "assistant", message: { content: "done" } },
    {
      type: "result",
      subtype: "success",
      usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      total_cost_usd: 0,
    },
  ];
  let index = 0;
  return {
    next: vi.fn(async () =>
      index < events.length
        ? { done: false, value: events[index++] }
        : { done: true, value: undefined },
    ),
    return: vi.fn(async () => ({ done: true, value: undefined })),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() {
      return this;
    },
  } as Query;
}

type HookCallback = (input: unknown) => Promise<Record<string, unknown>>;
type Hooks = NonNullable<ClaudeQueryInput["options"]["hooks"]>;

let repo: string;

async function launch(fileReadObserver?: FileReadObserver, cwd = repo): Promise<Hooks> {
  let captured: ClaudeQueryInput["options"] | undefined;
  const client = new ClaudeAgentClient({
    logger: pino({ level: "silent" }),
    queryFactory: ({ options }: ClaudeQueryInput) => {
      captured = options;
      return createQueryMock();
    },
    resolveBinary: async () => "/test/claude/bin",
    ...(fileReadObserver ? { fileReadObserver } : {}),
  });
  const session = await client.createSession(
    { provider: "claude", cwd, modeId: "bypassPermissions" },
    { agentId: "agent-1" },
  );
  try {
    await session.run("read check");
  } finally {
    await session.close();
  }
  if (!captured?.hooks) throw new Error("queryFactory was never called with hooks");
  return captured.hooks;
}

/** Every callback the CLI would run for `tool` on `event`: matcherless ones and exact matches. */
function callbacksFor(hooks: Hooks, event: "PreToolUse" | "PostToolUse", tool: string) {
  return (hooks[event] ?? [])
    .filter((entry) => entry.matcher === undefined || entry.matcher === tool)
    .flatMap((entry) => entry.hooks as unknown as HookCallback[]);
}

function readInput(
  event: "PreToolUse" | "PostToolUse",
  filePath: string,
  id: string,
  content = "",
) {
  return {
    hook_event_name: event,
    session_id: "read-check-session",
    transcript_path: "/dev/null",
    cwd: repo,
    tool_name: "Read",
    tool_input: { file_path: filePath },
    tool_use_id: id,
    ...(event === "PostToolUse"
      ? {
          tool_response: {
            type: "text",
            file: {
              filePath,
              content,
              numLines: content.split("\n").length - 1,
              startLine: 1,
              totalLines: content.split("\n").length - 1,
            },
          },
        }
      : {}),
  };
}

const DROP: JevSavingsSink = {
  record: () => "sv",
  settle: () => undefined,
  validate: () => undefined,
  countNotAsked: () => undefined,
  noteRead: () => undefined,
};

function bigSource(): string {
  const lines: string[] = [];
  for (let index = 0; index < 300; index += 1) {
    lines.push(`export const value${index} = computeSomethingUseful(${index}, "padding");`);
  }
  return `${lines.join("\n")}\n`;
}

/** The real observer over the real service, with JEV answering 2 seconds late. */
function slowObserver(config: Record<string, unknown> = {}, defer?: (work: () => void) => void) {
  const paseoHome = path.join(repo, "..", ".paseo");
  mkdirSync(paseoHome, { recursive: true });
  const transport = createFakeJevTransport({
    answers: { need: { type: "choice", choice: "not_needed", confidence: 0.91 } },
  });
  // Every answer comes 2 seconds late, as a slow JEV would.
  transport.send = withJevTransportDelay(
    { provider: "fake", send: transport.send.bind(transport) },
    2000,
  ).send;
  const jev = createTestJevService({
    paseoHome,
    homeDir: path.dirname(repo),
    config,
    transport,
    service: { resolveAgentCwds: async () => [repo] },
  });
  const resolved = resolveJevConfig(config, { homeDir: path.dirname(repo) });
  const observer = new ReadCheckObserver({
    jev,
    savings: DROP,
    readConfig: () => resolved.readCheck,
    agents: {
      agent: () => ({
        title: "t",
        cwd: repo,
        model: null,
        workspaceId: null,
        labels: {},
        contextTokens: null,
      }),
      assignment: () => "a",
      tail: () => ({ epoch: "e", rows: [] }),
      after: () => ({ epoch: "e", rows: [] }),
    },
    homeDir: path.dirname(repo),
    paseoHome,
    logger: pino({ level: "silent" }),
    sweepIntervalMs: 0,
    ...(defer ? { defer } : {}),
  });
  return { observer, jev };
}

beforeEach(() => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "claude-read-check-")));
  repo = path.join(root, "repo");
  mkdirSync(repo, { recursive: true });
});

afterEach(() => {
  rmSync(path.dirname(repo), { recursive: true, force: true });
});

describe("Claude read check: matchers", () => {
  test("with no observer, no read-check matcher is registered", async () => {
    const hooks = await launch();
    expect((hooks.PreToolUse ?? []).map((entry) => entry.matcher)).toEqual([
      undefined,
      "Bash",
      "Monitor",
    ]);
    expect((hooks.PostToolUse ?? []).map((entry) => entry.matcher)).toEqual([undefined]);
  });

  test("with an observer, its matchers come after the gates, which keep theirs", async () => {
    const observer: FileReadObserver = { preToolUse: () => null, postToolUse: () => undefined };
    const hooks = await launch(observer);
    expect((hooks.PreToolUse ?? []).map((entry) => entry.matcher)).toEqual([
      undefined,
      "Bash",
      "Monitor",
      "Read",
      "Bash",
      "Edit",
      "Write",
      "MultiEdit",
      "NotebookEdit",
    ]);
    expect((hooks.PostToolUse ?? []).map((entry) => entry.matcher)).toEqual([
      undefined,
      "Read",
      "Bash",
    ]);
    expect(hooks.PreToolUse?.slice(3).every((entry) => entry.timeout === 3)).toBe(true);
    // The catastrophe gate still refuses: it is the first Bash matcher.
    const gate = hooks.PreToolUse?.[1]?.hooks[0] as unknown as HookCallback;
    const result = await gate({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git push --force origin main" },
      tool_use_id: "t",
      cwd: repo,
    });
    expect(result["hookSpecificOutput"]).toMatchObject({ permissionDecision: "deny" });
  });
});

describe("Claude read check: shadow adds nothing to a read", () => {
  test("a shadow callback resolves {} before the observer's work starts", async () => {
    const queued: Array<() => void> = [];
    // The observer's judgment never even starts: every piece of work stays queued.
    const { observer, jev } = slowObserver({}, (work) => queued.push(work));
    const hooks = await launch(observer);
    const file = path.join(repo, "a.ts");
    writeFileSync(file, bigSource());

    const [pre] = callbacksFor(hooks, "PreToolUse", "Read").slice(-1);
    const [post] = callbacksFor(hooks, "PostToolUse", "Read").slice(-1);
    expect(await pre!(readInput("PreToolUse", file, "t1"))).toEqual({});
    expect(await post!(readInput("PostToolUse", file, "t1", bigSource()))).toEqual({});
    expect(queued).toHaveLength(1);
    expect(jev.transport.calls).toEqual([]);
  });

  test("an observer that throws returns {}", async () => {
    const observer: FileReadObserver = {
      preToolUse: () => {
        throw new Error("boom");
      },
      postToolUse: () => {
        throw new Error("boom");
      },
    };
    const hooks = await launch(observer);
    for (const event of ["PreToolUse", "PostToolUse"] as const) {
      const [callback] = callbacksFor(hooks, event, "Read").slice(-1);
      expect(await callback!(readInput(event, "/x", "t"))).toEqual({});
    }
  });

  test("the hooks a Read runs take the same time with the check on, JEV 2 s slow", async () => {
    const READS = 200;
    const content = bigSource();
    // A file per read, so every read with the check on starts its own 2-second judgment.
    const files = Array.from({ length: READS }, (_, index) => {
      const file = path.join(repo, `src/file-${index}.ts`);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
      return file;
    });
    const { observer, jev } = slowObserver();
    const decide = jev.decide.bind(jev);
    const judging = { started: 0, finished: 0 };
    jev.decide = async (input) => {
      judging.started += 1;
      const outcome = await decide(input);
      judging.finished += 1;
      return outcome;
    };
    const withCheck = await launch(observer);
    const without = await launch();

    // As the CLI does: the matching callbacks of one event run in parallel, Pre then Post. Each
    // read ends with one turn of the event loop, where the observer's deferred work runs, as it
    // does between the CLI's stdio messages; its synchronous cost lands in this read's time.
    async function oneRead(hooks: Hooks, file: string, id: string): Promise<number> {
      const startedAt = performance.now();
      await Promise.all(
        callbacksFor(hooks, "PreToolUse", "Read").map((cb) =>
          cb(readInput("PreToolUse", file, id)),
        ),
      );
      await Promise.all(
        callbacksFor(hooks, "PostToolUse", "Read").map((cb) =>
          cb(readInput("PostToolUse", file, id, content)),
        ),
      );
      await new Promise((resolve) => setImmediate(resolve));
      return performance.now() - startedAt;
    }

    const on: number[] = [];
    const off: number[] = [];
    for (let index = 0; index < READS; index += 1) {
      off.push(await oneRead(without, files[index]!, `off-${index}`));
      on.push(await oneRead(withCheck, files[index]!, `on-${index}`));
    }
    const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
    const median = (values: number[]) => sorted(values)[Math.floor(values.length / 2)]!;
    const p99 = (values: number[]) => sorted(values)[Math.floor(values.length * 0.99)]!;
    const max = (values: number[]) => Math.max(...values);
    // The judgments the reads started, and how many had an answer by the time the reads ended.
    const duringReads = { ...judging };
    await observer.idle();
    await observer.stop();
    const out = process.env["PASEO_READ_CHECK_LATENCY_OUT"];
    if (out) {
      appendFileSync(
        out,
        `${JSON.stringify({
          reads: READS,
          off: { medianMs: median(off), p99Ms: p99(off), maxMs: max(off) },
          on: { medianMs: median(on), p99Ms: p99(on), maxMs: max(on) },
          judgmentsStartedDuringReads: duringReads.started,
          judgmentsFinishedDuringReads: duringReads.finished,
          jevCallsSent: jev.transport.calls.length,
          judgmentsFinished: judging.finished,
          readsLane: jev.status().todayByFeature.readCheck,
        })}\n`,
      );
    }
    // Wide of the 2-second JEV on purpose: a hook that waited on it would take 2,000 ms, while
    // the event loop's own scheduling moves either side's median by about a millisecond.
    expect(max(on)).toBeLessThan(100);
    expect(median(on) - median(off)).toBeLessThan(5);
    // The reads started their 2-second judgments (the last few start a few event-loop turns after
    // their hooks returned) and none had an answer when the reads were done: no read waited on
    // one. Past the lane's two slots they queue and give up as saturated.
    expect(duringReads.started).toBeGreaterThanOrEqual(READS - 3);
    expect(duringReads.finished).toBe(0);
    expect(judging.finished).toBe(READS);
  }, 60_000);
});

describe("Claude read check: live mode", () => {
  const LIVE = {
    readCheck: { shadow: false, liveShare: 1, liveMinTokens: 3000, liveTimeoutMs: 1000 },
  };

  test("denies a large not-needed read once and lets the second through", async () => {
    const file = path.join(repo, "a.ts");
    writeFileSync(file, bigSource());
    const jev = createTestJevService({
      paseoHome: path.join(path.dirname(repo), ".paseo"),
      homeDir: path.dirname(repo),
      config: LIVE,
      answers: { need: { type: "choice", choice: "not_needed", confidence: 0.91 } },
      service: { resolveAgentCwds: async () => [repo] },
    });
    const resolved = resolveJevConfig(LIVE, { homeDir: path.dirname(repo) });
    const observer = new ReadCheckObserver({
      jev,
      savings: DROP,
      readConfig: () => resolved.readCheck,
      agents: {
        agent: () => null,
        assignment: () => null,
        tail: () => null,
        after: () => null,
      },
      homeDir: path.dirname(repo),
      paseoHome: path.join(path.dirname(repo), ".paseo"),
      logger: pino({ level: "silent" }),
      sweepIntervalMs: 0,
    });
    const hooks = await launch(observer);
    const [pre] = callbacksFor(hooks, "PreToolUse", "Read").slice(-1);

    const first = await pre!(readInput("PreToolUse", file, "t1"));
    expect(first["hookSpecificOutput"]).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
    });
    expect(
      String((first["hookSpecificOutput"] as Record<string, unknown>)["permissionDecisionReason"]),
    ).toContain("run the same Read again");
    expect(await pre!(readInput("PreToolUse", file, "t2"))).toEqual({});
    await observer.stop();
  });

  test("returns {} past the hold's timeout, whatever the observer does", async () => {
    const never: FileReadHold = { verdict: new Promise(() => undefined), timeoutMs: 50 };
    const observer: FileReadObserver = { preToolUse: () => never, postToolUse: () => undefined };
    const hooks = await launch(observer);
    const [pre] = callbacksFor(hooks, "PreToolUse", "Read").slice(-1);
    const startedAt = performance.now();
    expect(await pre!(readInput("PreToolUse", "/x", "t"))).toEqual({});
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });
});
