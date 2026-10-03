import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";

import {
  emptyLadderState,
  loadLadderState,
  saveLadderState,
  type LadderState,
} from "./ladder-state.js";

const logger = pino({ level: "silent" });
const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-ladder-state-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function baseObservation() {
  return {
    key: "stalled-agent:abc123",
    kind: "stalled-agent",
    active: true,
    remedy: "none" as const,
    title: "Agent stalled",
    summary: "No activity for 30 minutes",
  };
}

describe("jev fields on the ladder state", () => {
  test("a state carrying jevTriage, jevDeferredUntil and escalation.personFirst round-trips", async () => {
    const dir = createTempDir();
    const filePath = path.join(dir, "state.json");
    const state: LadderState = {
      ...emptyLadderState(),
      episodes: [
        {
          key: "stalled-agent:abc123",
          openedAt: "2026-09-28T00:00:00.000Z",
          openedInCooldown: false,
          observation: {
            ...baseObservation(),
            escalation: {
              task: "Check what abc123 is doing",
              personFirst: { reason: "waiting_on_human", confidence: 0.82 },
            },
          },
          jevTriage: {
            at: "2026-09-28T00:01:00.000Z",
            callId: "call-1",
            outcome: "answered",
            route: "needs_person",
            confidence: 0.84,
            evidenceCurrent: 0.9,
            action: "escalated to a person, no agent",
            applied: true,
          },
          jevDeferredUntil: "2026-09-28T00:11:00.000Z",
        },
      ],
    };
    await saveLadderState(filePath, state);
    const loaded = await loadLadderState(filePath, logger);
    expect(loaded).toEqual(state);
  });

  test("a state written before these fields existed still loads", async () => {
    const dir = createTempDir();
    const filePath = path.join(dir, "state.json");
    const legacy = {
      version: 1,
      episodes: [
        {
          key: "stalled-agent:def456",
          openedAt: "2026-09-27T00:00:00.000Z",
          openedInCooldown: false,
          observation: {
            ...baseObservation(),
            key: "stalled-agent:def456",
            escalation: { task: "Check what def456 is doing" },
          },
        },
      ],
      cooldowns: {},
      daily: { day: "2026-09-27", count: 1 },
    };
    writeFileSync(filePath, JSON.stringify(legacy), "utf8");
    const loaded = await loadLadderState(filePath, logger);
    expect(loaded.episodes).toHaveLength(1);
    expect(loaded.episodes[0]?.jevTriage).toBeUndefined();
    expect(loaded.episodes[0]?.jevDeferredUntil).toBeUndefined();
    expect(loaded.episodes[0]?.observation.escalation?.personFirst).toBeUndefined();
  });
});
