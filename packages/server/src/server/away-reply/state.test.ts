import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { AwayReplyState } from "./state.js";
import { T0 } from "./test-utils/fixtures.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function filePath(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "away-reply-state-"));
  roots.push(root);
  return path.join(root, "jev", "away-reply-state.json");
}

function open(file: string, now = T0): AwayReplyState {
  return new AwayReplyState({ filePath: file, logger: pino({ level: "silent" }), now: () => now });
}

describe("AwayReplyState", () => {
  it("keeps streaks, caps, answered episodes and Tyler's messages across a restart", async () => {
    const file = filePath();
    const state = open(file);
    state.recordSignal({
      kind: "human-prompt",
      agentId: "a",
      at: new Date(T0),
      clientMessageId: "m1",
    });
    state.recordReply("a", { at: T0 + 1, episodeKey: "a:turn:1", textHash: "h1" });
    state.recordOptOut("b");
    await state.flush();
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);

    const again = open(file);
    expect(again.agent("a")).toMatchObject({
      streak: 1,
      answered: ["a:turn:1"],
      sentHashes: ["h1"],
      humanMessageIds: ["m1"],
      lastHumanAt: T0,
    });
    expect(again.dailyCount("a")).toBe(1);
    expect(again.dailyTotal()).toBe(1);
    expect(again.agent("b").optedOutAt).toBe(T0);
  });

  it("resets the streak only on a human signal, never on a cancel", () => {
    const state = open(filePath());
    state.recordReply("a", { at: T0, episodeKey: "k1", textHash: null });
    state.recordReply("a", { at: T0, episodeKey: "k2", textHash: null });
    state.recordSignal({ kind: "turn-canceled", agentId: "a", at: new Date(T0), reason: "user" });
    expect(state.agent("a").streak).toBe(2);
    state.recordSignal({
      kind: "human-permission-response",
      agentId: "a",
      at: new Date(T0),
      requestId: "r",
      response: { behavior: "deny" },
    });
    expect(state.agent("a").streak).toBe(0);
  });

  it("starts the daily counts over at local midnight", () => {
    const state = open(filePath());
    state.recordReply("a", { at: T0, episodeKey: "k", textHash: null });
    state.rollDay(T0 + 24 * 60 * 60_000);
    expect(state.dailyTotal()).toBe(0);
    expect(state.dailyCount("a")).toBe(0);
  });

  it("hands a failover successor its predecessor's record", () => {
    const state = open(filePath());
    state.recordReply("old", { at: T0, episodeKey: "k", textHash: "h" });
    state.recordReply("old", { at: T0, episodeKey: "k2", textHash: "h2" });
    state.recordOptOut("old");
    state.inherit("old", "new");
    expect(state.agent("new")).toMatchObject({ streak: 2, optedOutAt: T0 });
    expect(state.dailyCount("new")).toBe(2);
  });

  it("sends nothing, and overwrites nothing, when the file cannot be read", async () => {
    const file = filePath();
    const state = open(file);
    state.recordOptOut("a");
    await state.flush();
    writeFileSync(file, "{ not json");
    const broken = open(file);
    expect(broken.isUsable()).toBe(false);
    broken.recordReply("a", { at: T0, episodeKey: "k", textHash: null });
    await broken.flush();
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("forgets agents gone for a month", async () => {
    const file = filePath();
    const state = open(file);
    state.recordOptOut("gone");
    await state.flush();
    const later = open(file, T0 + 31 * 24 * 60 * 60_000);
    later.prune(new Set());
    expect(later.agent("gone").optedOutAt).toBeNull();
  });
});
