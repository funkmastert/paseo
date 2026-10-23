import { describe, expect, it } from "vitest";
import {
  attentionPushLevel,
  computeNotificationPlan,
  isPushEligibleAttentionReason,
  isQuestionEndingMessage,
  type ClientPresenceState,
  PRESENCE_THRESHOLD_MS,
} from "./agent-attention-policy.js";

function state(overrides: Partial<ClientPresenceState>): ClientPresenceState {
  return {
    appVisible: true,
    focusedAgentId: null,
    focusedTerminalId: null,
    lastActivityAtMs: null,
    ...overrides,
  };
}

describe("computeNotificationPlan", () => {
  const nowMs = Date.parse("2026-04-19T12:00:00.000Z");
  const staleAtMs = nowMs - PRESENCE_THRESHOLD_MS - 1;
  const presentAtMs = nowMs - PRESENCE_THRESHOLD_MS + 1;

  it("does not suppress notifications when a focused client is stale", () => {
    const staleFocused = state({
      focusedAgentId: "agent-1",
      lastActivityAtMs: staleAtMs,
    });

    expect(
      computeNotificationPlan({
        allStates: [staleFocused],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, shouldPush: true });
  });

  it("suppresses notifications when a focused client is present", () => {
    const staleFocused = state({
      focusedAgentId: "agent-1",
      lastActivityAtMs: staleAtMs,
    });
    const presentFocused = state({
      focusedAgentId: "agent-1",
      lastActivityAtMs: presentAtMs,
    });

    expect(
      computeNotificationPlan({
        allStates: [staleFocused, presentFocused],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, shouldPush: false });
  });

  it("does not suppress notifications when a focused client is backgrounded", () => {
    const backgroundFocused = state({
      appVisible: false,
      focusedAgentId: "agent-1",
      lastActivityAtMs: presentAtMs,
    });

    expect(
      computeNotificationPlan({
        allStates: [backgroundFocused],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 0, shouldPush: false });
  });

  it("treats present clients focused on different agents as eligible", () => {
    expect(
      computeNotificationPlan({
        allStates: [
          state({
            focusedAgentId: "agent-2",
            lastActivityAtMs: nowMs - 1_000,
          }),
        ],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 0, shouldPush: false });
  });

  it("chooses the present client with the greatest clamped activity timestamp", () => {
    expect(
      computeNotificationPlan({
        allStates: [
          state({ lastActivityAtMs: nowMs - 10_000 }),
          state({ lastActivityAtMs: nowMs - 1_000 }),
          state({ lastActivityAtMs: staleAtMs }),
        ],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 1, shouldPush: false });
  });

  it("uses the lower index when present clients have identical timestamps", () => {
    expect(
      computeNotificationPlan({
        allStates: [
          state({ lastActivityAtMs: nowMs - 1_000 }),
          state({ lastActivityAtMs: nowMs - 1_000 }),
        ],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 0, shouldPush: false });
  });

  it("clamps future timestamps to now and treats them as present", () => {
    expect(
      computeNotificationPlan({
        allStates: [
          state({ lastActivityAtMs: nowMs - 1 }),
          state({ lastActivityAtMs: nowMs + 600_000 }),
        ],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 1, shouldPush: false });
  });

  it("never treats no-heartbeat clients as present", () => {
    expect(
      computeNotificationPlan({
        allStates: [state({ lastActivityAtMs: null })],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, shouldPush: true });
  });

  it("falls back to push for non-error attention when no clients are present", () => {
    expect(
      computeNotificationPlan({
        allStates: [state({ lastActivityAtMs: staleAtMs })],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, shouldPush: true });
  });

  it("does not push error attention when no clients are present", () => {
    expect(
      computeNotificationPlan({
        allStates: [state({ lastActivityAtMs: staleAtMs })],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: false,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, shouldPush: false });
  });

  it("lets a foreground mobile-style client with recent activity win as most recent", () => {
    expect(
      computeNotificationPlan({
        allStates: [
          state({ focusedAgentId: "agent-2", lastActivityAtMs: nowMs - 20_000 }),
          state({ focusedAgentId: null, lastActivityAtMs: nowMs - 500 }),
        ],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 1, shouldPush: false });
  });

  it("selects no in-app recipient and pushes when two web-style clients are stale", () => {
    expect(
      computeNotificationPlan({
        allStates: [state({ lastActivityAtMs: staleAtMs }), state({ lastActivityAtMs: staleAtMs })],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, shouldPush: true });
  });

  it("never suppresses when focusTarget is null even if a client focuses a matching id", () => {
    expect(
      computeNotificationPlan({
        allStates: [state({ focusedAgentId: "terminal-1", lastActivityAtMs: nowMs - 500 })],
        focusTarget: null,
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 0, shouldPush: false });
  });

  it("suppresses terminal notifications when a present visible client focuses the terminal", () => {
    expect(
      computeNotificationPlan({
        allStates: [state({ focusedTerminalId: "terminal-1", lastActivityAtMs: nowMs - 500 })],
        focusTarget: { kind: "terminal", id: "terminal-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, shouldPush: false });
  });

  it("pushes for a null-focus target when no client is present and push is eligible", () => {
    expect(
      computeNotificationPlan({
        allStates: [state({ lastActivityAtMs: staleAtMs })],
        focusTarget: null,
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, shouldPush: true });
  });
});

describe("isPushEligibleAttentionReason", () => {
  it("allows push for finished and permission but not error", () => {
    expect(isPushEligibleAttentionReason("finished")).toBe(true);
    expect(isPushEligibleAttentionReason("permission")).toBe(true);
    expect(isPushEligibleAttentionReason("error")).toBe(false);
  });
});

describe("attentionPushLevel", () => {
  it("makes an ordinary finish a notice, root agents included", () => {
    expect(attentionPushLevel("finished")).toBe("notice");
    expect(
      attentionPushLevel("finished", {
        isRootAgent: true,
        finalMessage: "Done. No action needed.",
      }),
    ).toBe("notice");
  });

  it("keeps a permission request an alert", () => {
    expect(attentionPushLevel("permission")).toBe("alert");
  });

  it("keeps an error an alert", () => {
    expect(attentionPushLevel("error")).toBe("alert");
  });

  it("raises a root agent's question-ending finish to an alert", () => {
    expect(
      attentionPushLevel("finished", { isRootAgent: true, finalMessage: "Should I proceed?" }),
    ).toBe("alert");
  });

  it("never raises a delegated child's question-ending finish", () => {
    expect(
      attentionPushLevel("finished", { isRootAgent: false, finalMessage: "Should I proceed?" }),
    ).toBe("notice");
  });
});

describe("isQuestionEndingMessage", () => {
  it("matches a plain question at the end of the message", () => {
    expect(isQuestionEndingMessage("I've reviewed the PR. Should I merge it?")).toBe(true);
  });

  it("ignores trailing markdown, quotes and whitespace after the question mark", () => {
    expect(isQuestionEndingMessage("**Should I proceed?**  ")).toBe(true);
    expect(isQuestionEndingMessage('He asked, "should I proceed?"')).toBe(true);
  });

  it("does not match an ordinary finish with no question", () => {
    expect(isQuestionEndingMessage("Done. Updated the README.")).toBe(false);
  });

  it("does not match null or empty messages", () => {
    expect(isQuestionEndingMessage(null)).toBe(false);
    expect(isQuestionEndingMessage("")).toBe(false);
  });

  it("ignores a question mark inside a trailing fenced code block", () => {
    const message = ["Here is the check:", "```", "ok?", "```"].join("\n");
    expect(isQuestionEndingMessage(message)).toBe(false);
  });

  it("ignores a question mark inside inline code, mid-message", () => {
    expect(isQuestionEndingMessage("I ran `is this ok?` and it passed. All done.")).toBe(false);
  });

  it("ignores a quoted question mark that is not the message's own ask", () => {
    const message = ['The log said: "did it work?"', "I confirmed it did. No action needed."].join(
      "\n",
    );
    expect(isQuestionEndingMessage(message)).toBe(false);
  });

  it("matches a question followed by a short numbered option list", () => {
    expect(isQuestionEndingMessage("Which do you prefer?\n1. A\n2. B")).toBe(true);
  });

  it("matches a question followed by a bulleted option list", () => {
    expect(isQuestionEndingMessage("Which do you prefer?\n- Option A\n- Option B")).toBe(true);
  });

  it("matches a trailing short parenthetical after the question mark", () => {
    expect(isQuestionEndingMessage("Proceed? (y/n)")).toBe(true);
  });

  it("matches a trailing short sign-off sentence after the question mark", () => {
    expect(isQuestionEndingMessage("Want me to continue? Let me know.")).toBe(true);
    expect(isQuestionEndingMessage("Should I merge it? Thanks.")).toBe(true);
  });

  it("matches a sign-off on its own trailing line, after a question on the line before it", () => {
    expect(isQuestionEndingMessage("Deploy the fix?\nLet me know.")).toBe(true);
  });

  it("matches two chained sign-off clauses after the question mark", () => {
    expect(isQuestionEndingMessage("Should we ship it? Thanks. Let me know.")).toBe(true);
  });

  it("matches a trailing list item that itself ends in a question mark", () => {
    expect(isQuestionEndingMessage("Pick a size:\n1. small\n2. large?")).toBe(true);
  });

  it("does not match a sign-off phrase that is only a prefix of the trailing word", () => {
    expect(isQuestionEndingMessage("Should we reschedule? Happy Thanksgiving")).toBe(false);
  });

  it("ignores a question mark inside a URL's query string", () => {
    expect(
      isQuestionEndingMessage("Pushed. Build log at https://ci.example.com/run/12?tab=log"),
    ).toBe(false);
  });

  it("does not match a trailing list with no question behind it", () => {
    expect(isQuestionEndingMessage("Options:\n1. A\n2. B")).toBe(false);
  });

  it("matches a question followed by exactly 6 list lines but not 7", () => {
    const sixItems = Array.from({ length: 6 }, (_, i) => `${i + 1}. Option ${i + 1}`);
    expect(isQuestionEndingMessage(["Which do you prefer?", ...sixItems].join("\n"))).toBe(true);

    const sevenItems = Array.from({ length: 7 }, (_, i) => `${i + 1}. Option ${i + 1}`);
    expect(isQuestionEndingMessage(["Which do you prefer?", ...sevenItems].join("\n"))).toBe(false);
  });

  it("matches a trailing emoji after the question mark", () => {
    expect(isQuestionEndingMessage("Merge it? 🙂")).toBe(true);
  });

  it("ignores a question mark ten lines from the end of a long report", () => {
    const lines = ["Should we ship this? Nobody answered it yet."];
    for (let i = 0; i < 9; i += 1) {
      lines.push(`Status line ${i}: all checks passed.`);
    }
    expect(isQuestionEndingMessage(lines.join("\n"))).toBe(false);
  });

  it("does not match a status update ending in a period", () => {
    expect(isQuestionEndingMessage("Deployed the fix to production.")).toBe(false);
  });

  it("strips a leading blockquote marker before reading the line", () => {
    expect(isQuestionEndingMessage("> Should I proceed with the deploy?")).toBe(true);
  });

  it("strips a 60,000-character run of trailing wrapper chars in one fast pass", () => {
    const message = `Should I proceed?${"'".repeat(60_000)}`;
    const start = performance.now();
    expect(isQuestionEndingMessage(message)).toBe(true);
    expect(performance.now() - start).toBeLessThan(200);
  });
});
