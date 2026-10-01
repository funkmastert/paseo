import { describe, expect, test } from "vitest";

import {
  READ_CHECK_WINDOW_MS,
  ReadCheckValidation,
  type ReadCheckTimelineRow,
  type ReadCheckWindowClose,
} from "./validation.js";

const QUOTE = "export function resolveSessionToken(request: Request): string {";
const T0 = Date.parse("2026-09-30T12:00:00.000Z");

function setup() {
  const closes: ReadCheckWindowClose[] = [];
  const validation = new ReadCheckValidation({
    now: () => T0,
    onClose: (close) => closes.push(close),
  });
  function open(mode: "shadow" | "live", savingsId = "sv_1") {
    validation.open({
      savingsId,
      agentId: "agent-1",
      path: "/repo/src/session.ts",
      spellings: ["/repo/src/session.ts", "src/session.ts"],
      mode,
      openedAt: T0,
      rangeText: `short line\n  ${QUOTE}\n`,
      after: { epoch: "e1", seq: 10 },
      turnId: "turn-1",
    });
  }
  return { validation, closes, open };
}

function row(
  seq: number,
  item: ReadCheckTimelineRow["item"],
  turnId = "turn-1",
): ReadCheckTimelineRow {
  return { seq, timestamp: new Date(T0 + seq * 1000).toISOString(), turnId, item };
}

describe("ReadCheckValidation", () => {
  test("an edit of the path is a false skip in shadow", () => {
    const { validation, closes, open } = setup();
    open("shadow");
    validation.noteEdit("agent-1", "/repo/src/session.ts", T0 + 120_000);
    expect(closes).toEqual([
      expect.objectContaining({
        savingsId: "sv_1",
        validation: { outcome: "false-skip", signal: "edited", afterMinutes: 2 },
      }),
    ]);
  });

  test("a later read of the path is a regret in live", () => {
    const { validation, closes, open } = setup();
    open("live");
    validation.noteRead("agent-1", "/repo/src/session.ts", T0 + 30_000);
    expect(closes[0]?.validation).toEqual({
      outcome: "regret",
      signal: "reread",
      afterMinutes: 0.5,
    });
  });

  test("another agent or another path is not a sign", () => {
    const { validation, closes, open } = setup();
    open("shadow");
    validation.noteRead("agent-2", "/repo/src/session.ts", T0 + 1000);
    validation.noteEdit("agent-1", "/repo/src/other.ts", T0 + 1000);
    expect(closes).toEqual([]);
  });

  test("a quoted line of 40 or more characters in a later message is a sign", () => {
    const { validation, closes, open } = setup();
    open("shadow");
    validation.scan("sv_1", "e1", [
      row(9, { type: "assistant_message", text: QUOTE }),
      row(11, { type: "assistant_message", text: "short line" }),
      row(12, { type: "assistant_message", text: `The handler:\n    ${QUOTE}` }),
    ]);
    expect(closes[0]?.validation.outcome).toBe("false-skip");
    expect(closes[0]?.validation.signal).toBe("quoted");
  });

  test("rows at or before the read are never counted", () => {
    const { validation, closes, open } = setup();
    open("shadow");
    validation.scan("sv_1", "e1", [row(10, { type: "assistant_message", text: QUOTE })]);
    expect(closes).toEqual([]);
  });

  test("in live, an ask_jev_file call on the path is redirected and held", () => {
    const { validation, closes, open } = setup();
    open("live");
    validation.scan("sv_1", "e1", [
      row(11, {
        type: "tool_call",
        callId: "c2",
        name: "mcp__paseo__ask_jev_file_bool",
        status: "completed",
        error: null,
        detail: { type: "unknown", input: { path: "src/session.ts" }, output: null },
      }),
    ]);
    expect(closes[0]?.validation).toEqual({
      outcome: "held",
      signal: "redirected",
      afterMinutes: 0.2,
    });
  });

  test("the window closes as held once a fourth turn starts", () => {
    const { validation, closes, open } = setup();
    open("shadow");
    validation.scan("sv_1", "e1", [
      row(11, { type: "assistant_message", text: "a" }, "turn-2"),
      row(12, { type: "assistant_message", text: "b" }, "turn-3"),
    ]);
    expect(closes).toEqual([]);
    validation.scan("sv_1", "e1", [row(13, { type: "assistant_message", text: QUOTE }, "turn-4")]);
    expect(closes[0]?.validation).toEqual({ outcome: "held", signal: null, afterMinutes: null });
  });

  test("the window closes as held after 60 minutes", () => {
    const { validation, closes, open } = setup();
    open("shadow");
    validation.expire(T0 + READ_CHECK_WINDOW_MS - 1);
    expect(closes).toEqual([]);
    validation.expire(T0 + READ_CHECK_WINDOW_MS);
    expect(closes[0]?.validation.outcome).toBe("held");
    expect(validation.size).toBe(0);
  });

  test("after a timeline reset, rows are judged by time", () => {
    const { validation, closes, open } = setup();
    open("shadow");
    validation.scan("sv_1", "e2", [
      {
        seq: 1,
        timestamp: new Date(T0 - 5000).toISOString(),
        item: { type: "assistant_message", text: QUOTE },
      },
    ]);
    expect(closes).toEqual([]);
    validation.scan("sv_1", "e2", [
      {
        seq: 2,
        timestamp: new Date(T0 + 5000).toISOString(),
        item: { type: "assistant_message", text: QUOTE },
      },
    ]);
    expect(closes[0]?.validation.signal).toBe("quoted");
  });
});
