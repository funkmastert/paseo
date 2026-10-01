import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import pino from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { resolveJevConfig } from "../../../jev/config.js";
import {
  createFakeJevTransport,
  createTestJevService,
  withJevTransportDelay,
} from "../../../jev/fake.js";
import { ReadCheckObserver, type FileReadObserver } from "../../../jev/read-check/observer.js";
import { ClaudeAgentClient } from "./agent.js";

/**
 * Feature 16's latency claim against the real Claude CLI (docs/jev.md, "Zero latency in shadow").
 * The CLI talks to a local fake of the Messages API, which answers every turn with one `Read`
 * until the run's files are used up, so no request leaves the machine and nothing is spent. The
 * fake times each read from the CLI's side: from the end of the response that asked for it to the
 * arrival of the request carrying its result. That gap holds the PreToolUse hooks, the Read, the
 * PostToolUse hooks and the CLI's own work.
 *
 * Runs only with `PASEO_READ_CHECK_LATENCY_CLAUDE_BIN` set to a `claude` binary; run it under
 * `env -i` with a scratch HOME so the CLI sees no login. `PASEO_READ_CHECK_LATENCY_OUT` collects
 * the numbers.
 */

const CLAUDE_BIN = process.env["PASEO_READ_CHECK_LATENCY_CLAUDE_BIN"];
const OUT = process.env["PASEO_READ_CHECK_LATENCY_OUT"];
const READS = Number(process.env["PASEO_READ_CHECK_LATENCY_READS"] ?? 30);
const ROUNDS = Number(process.env["PASEO_READ_CHECK_LATENCY_ROUNDS"] ?? 2);

interface FakeApi {
  url: string;
  /** Milliseconds per read, response end to result arrival. */
  gaps: number[];
  close(): Promise<void>;
}

function sse(res: http.ServerResponse, events: Array<Record<string, unknown>>): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const event of events) {
    res.write(`event: ${String(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}

function messageEvents(
  model: string,
  block: Record<string, unknown>,
  delta: Record<string, unknown> | null,
  stopReason: string,
): Array<Record<string, unknown>> {
  return [
    {
      type: "message_start",
      message: {
        id: `msg_${Math.random().toString(36).slice(2)}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: block },
    ...(delta ? [{ type: "content_block_delta", index: 0, delta }] : []),
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  ];
}

function countToolResults(body: Record<string, unknown>): number {
  const messages = Array.isArray(body["messages"]) ? body["messages"] : [];
  let count = 0;
  for (const message of messages as Array<Record<string, unknown>>) {
    const content = message["content"];
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block["type"] === "tool_result") count += 1;
    }
  }
  return count;
}

async function startFakeApi(files: string[]): Promise<FakeApi> {
  const gaps: number[] = [];
  const answeredAt = new Map<number, number>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const arrivedAt = performance.now();
      if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ type: "error", error: { type: "not_found_error", message: "no" } }),
        );
        return;
      }
      if (req.url.startsWith("/v1/messages/count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<
        string,
        unknown
      >;
      const model = typeof body["model"] === "string" ? body["model"] : "claude-fake";
      const tools = Array.isArray(body["tools"]) ? (body["tools"] as Array<{ name?: string }>) : [];
      const mainLoop = tools.some((tool) => tool.name === "Read");
      if (!mainLoop) {
        sse(
          res,
          messageEvents(
            model,
            { type: "text", text: "" },
            { type: "text_delta", text: "ok" },
            "end_turn",
          ),
        );
        return;
      }
      const step = countToolResults(body);
      const asked = answeredAt.get(step - 1);
      if (asked !== undefined && !answeredAt.has(step)) gaps.push(arrivedAt - asked);
      if (step >= files.length) {
        sse(
          res,
          messageEvents(
            model,
            { type: "text", text: "" },
            { type: "text_delta", text: "done" },
            "end_turn",
          ),
        );
        return;
      }
      sse(
        res,
        messageEvents(
          model,
          { type: "tool_use", id: `toolu_fake_${step}`, name: "Read", input: {} },
          { type: "input_json_delta", partial_json: JSON.stringify({ file_path: files[step] }) },
          "tool_use",
        ),
      );
      answeredAt.set(step, performance.now());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    gaps,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

let scratch: string;

function bigSource(seed: number): string {
  const lines: string[] = [];
  for (let index = 0; index < 300; index += 1) {
    lines.push(`export const value${seed}_${index} = computeSomethingUseful(${index}, "padding");`);
  }
  return `${lines.join("\n")}\n`;
}

/** One session, one turn of `READS` Reads; returns the per-read gaps. */
async function runReads(label: string, observer?: FileReadObserver): Promise<number[]> {
  const repo = path.join(scratch, label);
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  const files = Array.from({ length: READS }, (_, index) => {
    const file = path.join(repo, `src/file-${index}.ts`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bigSource(index));
    return file;
  });
  const api = await startFakeApi(files);
  const configDir = path.join(scratch, `config-${label}`);
  mkdirSync(configDir, { recursive: true });
  const client = new ClaudeAgentClient({
    logger: pino({ level: "silent" }),
    resolveBinary: async () => CLAUDE_BIN!,
    ...(observer ? { fileReadObserver: observer } : {}),
  });
  const session = await client.createSession(
    {
      provider: "claude",
      cwd: repo,
      modeId: "bypassPermissions",
      model: "claude-haiku-4-5-20251001",
    },
    {
      agentId: `agent-latency-${label}`,
      env: {
        ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: "fake-key-do-not-use",
        CLAUDE_CONFIG_DIR: configDir,
        DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1",
        DISABLE_AUTOUPDATER: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
    },
  );
  try {
    await session.run("Read the files you are asked to read.");
  } finally {
    await session.close();
    await api.close();
  }
  return api.gaps;
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
  return {
    n: values.length,
    meanMs: Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100,
    p10Ms: Math.round(at(0.1) * 100) / 100,
    medianMs: Math.round(at(0.5) * 100) / 100,
    p90Ms: Math.round(at(0.9) * 100) / 100,
    maxMs: Math.round(Math.max(...values) * 100) / 100,
  };
}

function slowShadowObserver(config: Record<string, unknown> = {}) {
  const root = path.join(scratch, "jev");
  mkdirSync(root, { recursive: true });
  const transport = createFakeJevTransport({
    answers: { need: { type: "choice", choice: "not_needed", confidence: 0.91 } },
  });
  transport.send = withJevTransportDelay(
    { provider: "fake", send: transport.send.bind(transport) },
    2000,
  ).send;
  const jev = createTestJevService({
    paseoHome: path.join(root, ".paseo"),
    homeDir: root,
    config,
    transport,
    service: { resolveAgentCwds: async () => [scratch] },
  });
  const decide = jev.decide.bind(jev);
  const judging = { started: 0 };
  jev.decide = async (input) => {
    judging.started += 1;
    return decide(input);
  };
  const resolved = resolveJevConfig(config, { homeDir: root });
  const observer = new ReadCheckObserver({
    jev,
    savings: {
      record: () => "",
      settle: () => undefined,
      validate: () => undefined,
      countNotAsked: () => undefined,
      noteRead: () => undefined,
    },
    readConfig: () => resolved.readCheck,
    agents: {
      agent: () => null,
      assignment: () => null,
      tail: () => null,
      after: () => null,
    },
    homeDir: root,
    paseoHome: path.join(root, ".paseo"),
    logger: pino({ level: "silent" }),
    sweepIntervalMs: 0,
  });
  return { observer, judging };
}

/** A positive control: a hook that holds every read 300 ms, as a slow live check would. */
function holdingObserver(): FileReadObserver {
  return {
    preToolUse: () => ({
      verdict: new Promise((resolve) => setTimeout(() => resolve(null), 300)),
      timeoutMs: 1000,
    }),
    postToolUse: () => undefined,
  };
}

describe.skipIf(!CLAUDE_BIN)("read check latency through the real Claude CLI", () => {
  beforeAll(() => {
    const base = path.join(os.homedir(), ".cache");
    mkdirSync(base, { recursive: true });
    scratch = realpathSync(mkdtempSync(path.join(base, "read-check-latency-")));
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  test("shadow adds nothing a Read can see; a 300 ms hold shows up as 300 ms", async () => {
    const off: number[] = [];
    const on: number[] = [];
    const hooksOnly: number[] = [];
    const rounds: Array<{ offMedianMs: number; hooksOnlyMedianMs: number; onMedianMs: number }> =
      [];
    let judged = 0;
    for (let round = 1; round <= ROUNDS; round += 1) {
      const offRun = await runReads(`off-${round}`);
      // The hooks registered and the observer measuring every read, but the feature off: what the
      // hooks themselves cost, without any judgment.
      const idle = slowShadowObserver({ readCheck: { enabled: false } });
      const hooksOnlyRun = await runReads(`hooks-${round}`, idle.observer);
      await idle.observer.stop();
      const { observer, judging } = slowShadowObserver();
      const onRun = await runReads(`on-${round}`, observer);
      judged += judging.started;
      await observer.stop();
      off.push(...offRun);
      hooksOnly.push(...hooksOnlyRun);
      on.push(...onRun);
      rounds.push({
        offMedianMs: summarize(offRun).medianMs,
        hooksOnlyMedianMs: summarize(hooksOnlyRun).medianMs,
        onMedianMs: summarize(onRun).medianMs,
      });
    }
    const control = await runReads("hold-300", holdingObserver());

    const result = {
      cli: path.basename(CLAUDE_BIN!),
      readsPerRun: READS,
      off: summarize(off),
      hooksOnFeatureOff: summarize(hooksOnly),
      shadowOnJev2s: summarize(on),
      judgmentsStarted: judged,
      rounds,
      control300msHold: summarize(control),
    };
    if (OUT) appendFileSync(OUT, `${JSON.stringify(result)}\n`);

    expect(off.length).toBe(ROUNDS * READS);
    expect(on.length).toBe(ROUNDS * READS);
    // The control proves the method sees a hook's wait.
    expect(summarize(control).medianMs - summarize(off).medianMs).toBeGreaterThan(250);
    // Shadow: within noise of off, nowhere near the 2-second JEV.
    expect(summarize(on).medianMs - summarize(off).medianMs).toBeLessThan(25);
    expect(judged).toBeGreaterThan(0);
  }, 600_000);
});
