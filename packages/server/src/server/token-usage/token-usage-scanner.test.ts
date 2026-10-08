import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TokenUsageRole } from "@getpaseo/protocol/token-usage/rpc-schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TokenUsageScanner } from "./token-usage-scanner.js";
import { TokenUsageStore } from "./token-usage-store.js";
import {
  FAKE_CLAUDE_SESSION,
  FAKE_CODEX_SESSION,
  claudeAssistantLine,
  claudeUserLine,
  codexSessionMetaLine,
  codexTurnContextLine,
  codexUsageLine,
} from "./test-utils/fixtures.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-01T13:00:00.000Z");
const AT = "2026-10-01T12:00:00.000Z";

let tmp: string;
let claudeRoot: string;
let codexRoot: string;
let projectDir: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "token-usage-scanner-"));
  claudeRoot = path.join(tmp, "claude", "projects");
  codexRoot = path.join(tmp, "codex", "sessions");
  projectDir = path.join(claudeRoot, "-fake-project");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(codexRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function harness(options?: { now?: number; budgetMs?: number; yieldEveryLines?: number }) {
  const store = new TokenUsageStore({
    rootDir: path.join(tmp, "home", "token-usage"),
    logger: { warn: () => undefined },
  });
  const scanner = new TokenUsageScanner({
    store,
    roots: [
      { provider: "claude", dir: claudeRoot },
      { provider: "codex", dir: codexRoot },
    ],
    logger: { warn: () => undefined },
    now: () => options?.now ?? NOW,
    budgetMs: options?.budgetMs,
    yieldEveryLines: options?.yieldEveryLines,
  });
  return { store, scanner };
}

function roles(entries: Record<string, TokenUsageRole> = {}): Map<string, TokenUsageRole> {
  return new Map(Object.entries({ [FAKE_CLAUDE_SESSION]: "leader", ...entries }));
}

/** Writes or appends lines, then dates the file so its age is deterministic. */
async function writeLines(
  filePath: string,
  lines: string[],
  options?: { append?: boolean; mtimeMs?: number; trailingNewline?: boolean },
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const text = lines.join("\n") + (options?.trailingNewline === false ? "" : "\n");
  if (options?.append) await fs.appendFile(filePath, text);
  else await fs.writeFile(filePath, text);
  const mtime = new Date(options?.mtimeMs ?? NOW - HOUR);
  await fs.utimes(filePath, mtime, mtime);
}

function totals(store: TokenUsageStore) {
  const rows = store.query(0);
  return {
    responses: rows.reduce((sum, row) => sum + row.responses, 0),
    output: rows.reduce((sum, row) => sum + row.output, 0),
    rows,
  };
}

const mainFile = () => path.join(projectDir, `${FAKE_CLAUDE_SESSION}.jsonl`);

describe("TokenUsageScanner", () => {
  it("counts only the responses appended since the last sweep", async () => {
    const { store, scanner } = harness();
    await writeLines(mainFile(), [
      claudeUserLine(),
      claudeAssistantLine({ messageId: "m1", output: 100, timestamp: AT }),
      claudeAssistantLine({ messageId: "m2", output: 200, timestamp: AT }),
    ]);
    await scanner.sweep({ roles: roles() });
    expect(totals(store)).toMatchObject({ responses: 2, output: 300 });

    await writeLines(mainFile(), [claudeAssistantLine({ messageId: "m3", output: 50 })], {
      append: true,
    });
    const second = await scanner.sweep({ roles: roles() });

    expect(second.responses).toBe(1);
    expect(totals(store)).toMatchObject({ responses: 3, output: 350 });
  });

  it("leaves a partial last line until its newline arrives", async () => {
    const { store, scanner } = harness();
    const line = claudeAssistantLine({ messageId: "m1", output: 100 });
    const cut = Math.floor(line.length / 2);
    await writeLines(mainFile(), [line.slice(0, cut)], { trailingNewline: false });
    await scanner.sweep({ roles: roles() });
    expect(totals(store).responses).toBe(0);

    await writeLines(mainFile(), [line.slice(cut)], { append: true });
    await scanner.sweep({ roles: roles() });

    expect(totals(store)).toMatchObject({ responses: 1, output: 100 });
  });

  it("counts a response once when its repeat lands after a sweep boundary, adding only growth", async () => {
    const { store, scanner } = harness();
    await writeLines(mainFile(), [claudeAssistantLine({ messageId: "m1", output: 5 })]);
    await scanner.sweep({ roles: roles() });

    await writeLines(
      mainFile(),
      [
        claudeAssistantLine({ messageId: "m1", output: 5 }),
        // A subagent's later lines for one response report its output as it grows.
        claudeAssistantLine({ messageId: "m1", output: 113 }),
      ],
      { append: true },
    );
    await scanner.sweep({ roles: roles() });

    expect(totals(store)).toMatchObject({ responses: 1, output: 113 });
  });

  it("skips a response Claude writes again far down the file with its original time", async () => {
    const { store, scanner } = harness();
    await writeLines(mainFile(), [
      claudeAssistantLine({ messageId: "m1", timestamp: "2026-10-01T10:00:00.000Z" }),
      ...Array.from({ length: 20 }, (_, index) =>
        claudeAssistantLine({ messageId: `later-${index}`, timestamp: "2026-10-01T11:00:00.000Z" }),
      ),
      claudeAssistantLine({ messageId: "m1", timestamp: "2026-10-01T10:00:00.000Z" }),
    ]);

    await scanner.sweep({ roles: roles() });

    expect(totals(store).responses).toBe(21);
  });

  it("reads a file that shrank as a new file", async () => {
    const { store, scanner } = harness();
    await writeLines(mainFile(), [
      claudeAssistantLine({ messageId: "m1", output: 100 }),
      claudeAssistantLine({ messageId: "m2", output: 100 }),
    ]);
    await scanner.sweep({ roles: roles() });

    await writeLines(mainFile(), [claudeAssistantLine({ messageId: "m3", output: 7 })]);
    await scanner.sweep({ roles: roles() });

    expect(totals(store)).toMatchObject({ responses: 3, output: 207 });
  });

  it("books each session under its role, and a sidechain under its session's", async () => {
    const { store, scanner } = harness();
    await writeLines(path.join(projectDir, "worker-session.jsonl"), [
      claudeAssistantLine({ messageId: "w1", sessionId: "worker-session" }),
    ]);
    await writeLines(path.join(projectDir, "unknown-session.jsonl"), [
      claudeAssistantLine({ messageId: "o1", sessionId: "unknown-session" }),
    ]);
    // A subagent's transcript lives under its session's folder and names the parent session.
    await writeLines(path.join(projectDir, FAKE_CLAUDE_SESSION, "subagents", "agent-fake.jsonl"), [
      claudeAssistantLine({ messageId: "s1", isSidechain: true, model: "claude-sonnet-5" }),
    ]);

    await scanner.sweep({ roles: roles({ "worker-session": "worker" }) });

    const byRole = Object.fromEntries(
      totals(store).rows.map((row) => [`${row.model}/${row.role}`, row.responses]),
    );
    expect(byRole).toEqual({
      "claude-opus-5-5/worker": 1,
      "claude-opus-5-5/outside": 1,
      "claude-sonnet-5/leader": 1,
    });
  });

  it("leaves a young unclaimed session unread, then books it as outside once it is old", async () => {
    const file = path.join(projectDir, "young-session.jsonl");
    await writeLines(file, [claudeAssistantLine({ messageId: "y1", sessionId: "young-session" })], {
      mtimeMs: NOW - 2 * MINUTE,
    });
    const young = harness();
    const deferred = await young.scanner.sweep({ roles: roles() });
    expect(totals(young.store).responses).toBe(0);
    expect(deferred.filesDone).toBe(0);

    const later = harness({ now: NOW + 9 * MINUTE });
    await later.scanner.sweep({ roles: roles() });

    expect(totals(later.store).rows).toMatchObject([{ role: "outside", responses: 1 }]);
  });

  it("books a young session as soon as an agent claims it", async () => {
    const file = path.join(projectDir, "claimed-session.jsonl");
    await writeLines(
      file,
      [claudeAssistantLine({ messageId: "c1", sessionId: "claimed-session" })],
      { mtimeMs: NOW - MINUTE },
    );
    const { store, scanner } = harness();

    await scanner.sweep({ roles: roles({ "claimed-session": "worker" }) });

    expect(totals(store).rows).toMatchObject([{ role: "worker", responses: 1 }]);
  });

  it("stops at its budget and resumes where it stopped, counting every response once", async () => {
    const lines = Array.from({ length: 6 }, (_, index) =>
      claudeAssistantLine({ messageId: `m${index}`, output: 10 }),
    );
    await writeLines(mainFile(), lines);
    await writeLines(path.join(projectDir, "second.jsonl"), [
      claudeAssistantLine({ messageId: "x1", sessionId: "second", output: 1 }),
    ]);
    const { store, scanner } = harness({ budgetMs: 0, yieldEveryLines: 1 });

    const first = await scanner.sweep({ roles: roles() });
    expect(first.complete).toBe(false);
    expect(first.responses).toBe(1);

    let sweeps = 1;
    let last = first;
    while (!last.complete && sweeps < 20) {
      last = await scanner.sweep({ roles: roles() });
      sweeps += 1;
    }

    expect(last).toMatchObject({ complete: true, filesDone: 2, filesTotal: 2 });
    expect(sweeps).toBeGreaterThan(2);
    expect(totals(store)).toMatchObject({ responses: 7, output: 61 });
  });

  it("counts a forked session's copied history once, whichever file is read first", async () => {
    const shared = [
      claudeAssistantLine({ messageId: "p1", output: 10, timestamp: "2026-10-01T11:00:00.000Z" }),
      claudeAssistantLine({ messageId: "p2", output: 10, timestamp: "2026-10-01T11:01:00.000Z" }),
    ];
    await writeLines(
      path.join(projectDir, "parent.jsonl"),
      [...shared, claudeAssistantLine({ messageId: "a1", output: 1 })],
      { mtimeMs: NOW - 2 * HOUR },
    );
    // The fork is newer, so it is read first.
    await writeLines(
      path.join(projectDir, "fork.jsonl"),
      [
        ...shared.map((line) => line.replace(FAKE_CLAUDE_SESSION, "fork")),
        claudeAssistantLine({ messageId: "f1", sessionId: "fork", output: 100 }),
      ],
      { mtimeMs: NOW - HOUR },
    );
    const { store, scanner } = harness();

    await scanner.sweep({ roles: roles({ parent: "leader", fork: "leader" }) });

    expect(totals(store)).toMatchObject({ responses: 4, output: 121 });
  });

  it("skips a new fork's copied history against its parent read in an earlier sweep", async () => {
    const shared = [claudeAssistantLine({ messageId: "p1", output: 10 })];
    await writeLines(path.join(projectDir, "parent.jsonl"), shared);
    const { store, scanner } = harness();
    await scanner.sweep({ roles: roles() });

    await writeLines(path.join(projectDir, "fork.jsonl"), [
      ...shared,
      claudeAssistantLine({ messageId: "f1", output: 100 }),
    ]);
    await scanner.sweep({ roles: roles() });

    expect(totals(store)).toMatchObject({ responses: 2, output: 110 });
  });

  it("defers a fork line instead of guessing when a requested stop interrupts its parent-id read", async () => {
    // #12: `readResponseIds`'s parent read is unbudgeted on purpose (a fork is rare, and stopping
    // halfway would leave its copy half-skipped), but it must still honor a cooperative stop. A
    // partial id set must never decide "not a copy" — that would double-book a response the
    // parent already counted.
    const shared = [claudeAssistantLine({ messageId: "p1", output: 10 })];
    await writeLines(path.join(projectDir, "parent.jsonl"), shared);
    const { store, scanner } = harness({ yieldEveryLines: 1 });
    await scanner.sweep({ roles: roles() });

    await writeLines(path.join(projectDir, "fork.jsonl"), [
      ...shared,
      claudeAssistantLine({ messageId: "f1", output: 100 }),
    ]);
    scanner.requestStop();
    await scanner.sweep({ roles: roles() });

    // Nothing from the fork is counted yet — the parent-id read was interrupted before it could
    // tell whether "p1" is a copy, so the line is deferred rather than booked either way.
    expect(totals(store)).toMatchObject({ responses: 1, output: 10 });

    // A fresh scanner (the shape of a restart) reads the parent again from the start and resolves
    // it correctly: the fork's own new response books, its copied "p1" still doesn't double-count.
    const retry = new TokenUsageScanner({
      store,
      roots: [
        { provider: "claude", dir: claudeRoot },
        { provider: "codex", dir: codexRoot },
      ],
      logger: { warn: () => undefined },
      now: () => NOW,
    });
    await retry.sweep({ roles: roles() });
    expect(totals(store)).toMatchObject({ responses: 2, output: 110 });
  });

  it("reads a Codex rollout with its model and root session", async () => {
    const file = path.join(codexRoot, "2026", "10", "01", "rollout-fake.jsonl");
    await writeLines(file, [
      codexSessionMetaLine(),
      codexTurnContextLine("gpt-fake-5"),
      codexUsageLine({ responseId: "r1", input: 1_000, cached: 800, output: 10 }),
      codexUsageLine({ responseId: "r2", input: 2_000, cached: 1_500, output: 20 }),
    ]);
    const { store, scanner } = harness();

    await scanner.sweep({ roles: roles({ [FAKE_CODEX_SESSION]: "worker" }) });

    expect(totals(store).rows).toEqual([
      {
        provider: "codex",
        model: "gpt-fake-5",
        role: "worker",
        input: 700,
        cacheWrite: 0,
        cacheRead: 2_300,
        output: 30,
        weighted: 700 + 230 + 150,
        responses: 2,
      },
    ]);
  });

  it("reads a tree linked from two roots once", async () => {
    await writeLines(mainFile(), [claudeAssistantLine({ messageId: "m1" })]);
    const linkedHome = path.join(tmp, "claude-personal");
    await fs.mkdir(linkedHome, { recursive: true });
    await fs.symlink(claudeRoot, path.join(linkedHome, "projects"));
    const store = new TokenUsageStore({
      rootDir: path.join(tmp, "home", "token-usage"),
      logger: { warn: () => undefined },
    });
    const scanner = new TokenUsageScanner({
      store,
      roots: [
        { provider: "claude", dir: claudeRoot },
        { provider: "claude", dir: path.join(linkedHome, "projects") },
      ],
      logger: { warn: () => undefined },
      now: () => NOW,
    });

    const result = await scanner.sweep({ roles: roles() });

    expect(result.filesTotal).toBe(1);
    expect(totals(store).responses).toBe(1);
  });

  it("ignores transcripts untouched for longer than the window and responses past retention", async () => {
    await writeLines(
      path.join(projectDir, "old.jsonl"),
      [claudeAssistantLine({ messageId: "o1" })],
      {
        mtimeMs: NOW - 31 * DAY,
      },
    );
    await writeLines(mainFile(), [
      claudeAssistantLine({ messageId: "ancient", timestamp: "2026-08-01T00:00:00.000Z" }),
      claudeAssistantLine({ messageId: "recent", timestamp: AT }),
    ]);
    const { store, scanner } = harness();

    const result = await scanner.sweep({ roles: roles() });

    expect(result.filesTotal).toBe(1);
    expect(totals(store).responses).toBe(1);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps what it read from a folder it briefly cannot list, rather than reading it twice",
    async () => {
      const otherProject = path.join(claudeRoot, "-other-project");
      await writeLines(path.join(otherProject, "other.jsonl"), [
        claudeAssistantLine({ messageId: "o1", sessionId: "other" }),
      ]);
      const { store, scanner } = harness();
      await scanner.sweep({ roles: roles({ other: "leader" }) });

      await fs.chmod(otherProject, 0o000);
      try {
        await scanner.sweep({ roles: roles({ other: "leader" }) });
      } finally {
        await fs.chmod(otherProject, 0o755);
      }
      await scanner.sweep({ roles: roles({ other: "leader" }) });

      expect(totals(store).responses).toBe(1);
    },
  );

  it("finds nothing and fails nothing when the trees do not exist", async () => {
    await fs.rm(path.join(tmp, "claude"), { recursive: true });
    await fs.rm(path.join(tmp, "codex"), { recursive: true });
    const { scanner } = harness();

    await expect(scanner.sweep({ roles: roles() })).resolves.toMatchObject({
      filesTotal: 0,
      complete: true,
    });
  });
});
