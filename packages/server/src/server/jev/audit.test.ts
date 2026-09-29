import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";

import type { JevState, JevWireRequest } from "./contract.js";
import {
  buildJevAuditLine,
  JevAudit,
  type BuildJevAuditLineInput,
  type JevAuditLine,
} from "./audit.js";

const logger = pino({ level: "silent" });
const MODE_MASK = 0o777;

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jev-audit-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const QUESTIONS: JevWireRequest["questions"] = {
  task_class: {
    type: "choice",
    instructions: "Which class?",
    criteria: { mechanical: "Rote", other: "None" },
  },
};

function baseLedgerFields(overrides: Partial<BuildJevAuditLineInput["ledger"]> = {}) {
  return {
    callId: "call-1",
    at: new Date().toISOString(),
    feature: "spawnHint" as const,
    callSite: "test.call-site",
    attempts: 1,
    elapsedMs: 10,
    stateBytes: 20,
    bodyBytes: 100,
    redactions: 0,
    cost: { usd: 0.001, source: "reported" as const },
    outcome: "answered" as const,
    reason: null,
    model: "jev-fake",
    ...overrides,
  };
}

function buildLine(
  lane: BuildJevAuditLineInput["lane"],
  state: JevState,
  overrides: Partial<BuildJevAuditLineInput> = {},
): JevAuditLine {
  return buildJevAuditLine({
    lane,
    request: { model: "jev-fake", state, questions: QUESTIONS },
    answers: {
      task_class: {
        type: "choice",
        choice: "mechanical",
        probabilities: { mechanical: 1, other: 0 },
        confidence: 0.9,
      },
    },
    ledger: baseLedgerFields(),
    ...overrides,
  });
}

function controlLine(
  state: JevState = { title: "t", prompt: "p" },
  callId = "call-1",
): JevAuditLine {
  return buildLine("control", state, { ledger: baseLedgerFields({ callId }) });
}

describe("buildJevAuditLine", () => {
  test("keeps the redacted state, sha256 and byte length for a control line", () => {
    const line = controlLine();
    expect(line.v).toBe(1);
    expect(line.state).toEqual({ title: "t", prompt: "p" });
    expect(line.stateTruncated).toBe(false);
    expect(line.stateBytesTotal).toBe(
      Buffer.byteLength(JSON.stringify({ title: "t", prompt: "p" })),
    );
    expect(line.stateSha256).toHaveLength(64);
    expect(line.questions).toEqual(QUESTIONS);
    expect(line.answers).toEqual({
      task_class: {
        type: "choice",
        choice: "mechanical",
        probabilities: { mechanical: 1, other: 0 },
        confidence: 0.9,
      },
    });
  });

  test("truncates state over 16 KB and still reports the full sha256 and byte length", () => {
    const bigPrompt = "x".repeat(20_000);
    const line = controlLine({ prompt: bigPrompt });
    expect(line.stateTruncated).toBe(true);
    expect(typeof line.state).toBe("string");
    expect(Buffer.byteLength(line.state as string, "utf8")).toBe(16 * 1024);
    const fullSerialized = JSON.stringify({ prompt: bigPrompt });
    expect(line.stateBytesTotal).toBe(Buffer.byteLength(fullSerialized, "utf8"));
    expect(line.stateSha256).toBe(
      createHash("sha256").update(fullSerialized, "utf8").digest("hex"),
    );
  });

  test("agentTools: hashes state.content, never storing the content string in the line", () => {
    const secretContent = "SECRET-FILE-CONTENT-should-never-appear";
    const line = buildLine("agentTools", { path: "a.ts", content: secretContent });
    const serialized = JSON.stringify(line);
    expect(serialized).not.toContain(secretContent);
    expect(line.state).toMatchObject({
      path: "a.ts",
      content: { bytes: Buffer.byteLength(secretContent, "utf8") },
    });
    expect((line.state as { content: { sha256: string } }).content.sha256).toHaveLength(64);
  });

  test("agentTools: hashes every value of state.files, never storing file content", () => {
    const fileA = "content of file a";
    const fileB = "content of file b";
    const line = buildLine("agentTools", { files: { "a.ts": fileA, "b.ts": fileB } });
    const serialized = JSON.stringify(line);
    expect(serialized).not.toContain(fileA);
    expect(serialized).not.toContain(fileB);
    const files = (line.state as { files: Record<string, { sha256: string; bytes: number }> })
      .files;
    expect(files["a.ts"].bytes).toBe(Buffer.byteLength(fileA, "utf8"));
    expect(files["b.ts"].bytes).toBe(Buffer.byteLength(fileB, "utf8"));
  });

  test("agentTools: keeps every other field like a control state", () => {
    const line = buildLine("agentTools", {
      command: "cat file.txt",
      output: "hello",
      content: "keep-hashed",
    });
    expect(line.state).toMatchObject({ command: "cat file.txt", output: "hello" });
  });
});

async function makeAudit(overrides: { now?: () => number; platform?: NodeJS.Platform } = {}) {
  const dir = path.join(tempDir(), "jev");
  const audit = new JevAudit({ dir, logger, now: overrides.now, platform: overrides.platform });
  return { audit, dir };
}

describe("JevAudit init", () => {
  test.skipIf(process.platform === "win32")(
    "creates the dir 0700 and does no file work when none exists",
    async () => {
      const { audit, dir } = await makeAudit();
      await audit.init({ retainDays: 3 });
      expect(statSync(dir).mode & MODE_MASK).toBe(0o700);
      expect(existsSync(path.join(dir, "audit.jsonl"))).toBe(false);
    },
  );

  test.skipIf(process.platform === "win32")(
    "narrows a pre-existing wide-mode dir and file",
    async () => {
      const { audit, dir } = await makeAudit();
      await fs.mkdir(dir, { recursive: true, mode: 0o755 });
      const filePath = path.join(dir, "audit.jsonl");
      await fs.writeFile(filePath, "", { mode: 0o644 });
      await audit.init({ retainDays: 3 });
      expect(statSync(dir).mode & MODE_MASK).toBe(0o700);
      expect(statSync(filePath).mode & MODE_MASK).toBe(0o600);
    },
  );

  test("drops lines older than retainDays at init", async () => {
    const nowMs = Date.parse("2026-09-28T00:00:00.000Z");
    const { audit, dir } = await makeAudit({ now: () => nowMs });
    await fs.mkdir(dir, { recursive: true });
    const recent = JSON.stringify(
      controlLine(undefined, "recent") as unknown as Record<string, unknown>,
    );
    const recentWithAt = JSON.stringify({
      ...(JSON.parse(recent) as Record<string, unknown>),
      at: new Date(nowMs - 60_000).toISOString(),
    });
    const staleWithAt = JSON.stringify({
      ...(JSON.parse(recent) as Record<string, unknown>),
      at: new Date(nowMs - 10 * 24 * 60 * 60_000).toISOString(),
    });
    await fs.writeFile(path.join(dir, "audit.jsonl"), `${staleWithAt}\n${recentWithAt}\n`);
    await audit.init({ retainDays: 3 });
    const lines = readFileSync(path.join(dir, "audit.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]) as { at: string }).at).toBe(
      new Date(nowMs - 60_000).toISOString(),
    );
  });
});

describe("JevAudit append", () => {
  test("disabled: no file is created", async () => {
    const { audit, dir } = await makeAudit();
    audit.append(controlLine(), { enabled: false, maxBytes: 1_000_000, retainDays: 3 });
    await audit.flush();
    expect(existsSync(path.join(dir, "audit.jsonl"))).toBe(false);
  });

  test("appends one JSON line per call", async () => {
    const { audit, dir } = await makeAudit();
    await audit.init({ retainDays: 3 });
    audit.append(controlLine(), { enabled: true, maxBytes: 1_000_000, retainDays: 3 });
    await audit.flush();
    const lines = readFileSync(path.join(dir, "audit.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  test.skipIf(process.platform === "win32")("writes with mode 0600", async () => {
    const { audit, dir } = await makeAudit();
    await audit.init({ retainDays: 3 });
    audit.append(controlLine(), { enabled: true, maxBytes: 1_000_000, retainDays: 3 });
    await audit.flush();
    expect(statSync(path.join(dir, "audit.jsonl")).mode & MODE_MASK).toBe(0o600);
  });

  test("many appends land in order with no interleaving or lost lines", async () => {
    const { audit, dir } = await makeAudit();
    await audit.init({ retainDays: 3 });
    const count = 40;
    for (let i = 0; i < count; i += 1) {
      audit.append(controlLine(undefined, `call-${i}`), {
        enabled: true,
        maxBytes: 1_000_000,
        retainDays: 3,
      });
    }
    await audit.flush();
    const lines = readFileSync(path.join(dir, "audit.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(count);
    const callIds = lines.map((line) => (JSON.parse(line) as { callId: string }).callId);
    expect(callIds).toEqual(Array.from({ length: count }, (_, i) => `call-${i}`));
  });

  test("rotates to audit.1.jsonl when the current size would pass maxBytes", async () => {
    const { audit, dir } = await makeAudit();
    await audit.init({ retainDays: 3 });
    const line1 = controlLine(undefined, "call-1");
    const line1Bytes = Buffer.byteLength(`${JSON.stringify(line1)}\n`, "utf8");
    const maxBytes = line1Bytes + 5;

    audit.append(line1, { enabled: true, maxBytes, retainDays: 3 });
    await audit.flush();
    expect(existsSync(path.join(dir, "audit.1.jsonl"))).toBe(false);

    audit.append(controlLine(undefined, "call-2"), { enabled: true, maxBytes, retainDays: 3 });
    await audit.flush();

    expect(existsSync(path.join(dir, "audit.1.jsonl"))).toBe(true);
    const rotated = readFileSync(path.join(dir, "audit.1.jsonl"), "utf8").trim().split("\n");
    expect(rotated).toHaveLength(1);
    expect((JSON.parse(rotated[0]) as { callId: string }).callId).toBe("call-1");
    const current = readFileSync(path.join(dir, "audit.jsonl"), "utf8").trim().split("\n");
    expect(current).toHaveLength(1);
    expect((JSON.parse(current[0]) as { callId: string }).callId).toBe("call-2");
  });

  test("prunes the rotated file by retainDays right after rotation", async () => {
    const nowMs = Date.parse("2026-09-28T00:00:00.000Z");
    const { audit, dir } = await makeAudit({ now: () => nowMs });
    await fs.mkdir(dir, { recursive: true });
    const stale = JSON.stringify({
      ...(controlLine() as unknown as Record<string, unknown>),
      at: new Date(nowMs - 10 * 24 * 60 * 60_000).toISOString(),
    });
    await fs.writeFile(path.join(dir, "audit.1.jsonl"), `${stale}\n`);
    await audit.init({ retainDays: 3 });

    const line1 = controlLine(undefined, "call-1");
    const maxBytes = Buffer.byteLength(`${JSON.stringify(line1)}\n`, "utf8") + 5;
    audit.append(line1, { enabled: true, maxBytes, retainDays: 3 });
    await audit.flush();
    audit.append(controlLine(undefined, "call-2"), { enabled: true, maxBytes, retainDays: 3 });
    await audit.flush();

    const rotated = readFileSync(path.join(dir, "audit.1.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(rotated).toHaveLength(1);
    expect((JSON.parse(rotated[0]) as { callId: string }).callId).toBe("call-1");
  });
});
