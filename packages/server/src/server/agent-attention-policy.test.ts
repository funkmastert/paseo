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
});
