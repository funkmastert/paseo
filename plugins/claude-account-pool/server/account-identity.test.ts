import { describe, expect, it } from "vitest";
import { createAccountIdentity } from "./account-identity";
import { WINDOW_FIVE_HOUR, WINDOW_SEVEN_DAY } from "./windows";

const FIVE_HOUR_RESET = new Date("2026-09-22T15:10:00Z");
const WEEKLY_RESET = new Date("2026-09-26T09:00:00Z");

function sharedReadings(fiveHourPct: number, weeklyPct: number) {
  return [
    { window: WINDOW_FIVE_HOUR, usedPct: fiveHourPct, resetsAt: FIVE_HOUR_RESET },
    { window: WINDOW_SEVEN_DAY, usedPct: weeklyPct, resetsAt: WEEKLY_RESET },
  ];
}

describe("createAccountIdentity", () => {
  it("groups two provider entries reporting identical windows — the claude / claude-personal case", () => {
    const identity = createAccountIdentity();
    identity.reportUsage("claude", sharedReadings(31, 77));
    identity.reportUsage("claude-personal", sharedReadings(31, 77));
    identity.reportUsage("worker-a", [
      { window: WINDOW_FIVE_HOUR, usedPct: 12, resetsAt: new Date("2026-09-22T16:40:00Z") },
      { window: WINDOW_SEVEN_DAY, usedPct: 74, resetsAt: new Date("2026-09-25T11:00:00Z") },
    ]);

    expect(identity.accountKey("claude")).toBe(identity.accountKey("claude-personal"));
    expect(identity.accountKey("worker-a")).not.toBe(identity.accountKey("claude"));
    expect(identity.siblings("claude")).toEqual(["claude", "claude-personal"]);
    // Three entries, two accounts: a pool down to "claude" + "claude-personal" has collapsed.
    expect(identity.countAccounts(["claude", "claude-personal", "worker-a"])).toBe(2);
    expect(identity.countAccounts(["claude", "claude-personal"])).toBe(1);
  });

  it("keeps entries distinct when only the percentages match and the resets differ", () => {
    const identity = createAccountIdentity();
    identity.reportUsage("worker-a", [
      { window: WINDOW_FIVE_HOUR, usedPct: 0, resetsAt: new Date("2026-09-22T15:00:00Z") },
      { window: WINDOW_SEVEN_DAY, usedPct: 0, resetsAt: new Date("2026-09-26T09:00:00Z") },
    ]);
    identity.reportUsage("worker-b", [
      { window: WINDOW_FIVE_HOUR, usedPct: 0, resetsAt: new Date("2026-09-22T15:00:01Z") },
      { window: WINDOW_SEVEN_DAY, usedPct: 0, resetsAt: new Date("2026-09-26T09:00:00Z") },
    ]);

    expect(identity.accountKey("worker-a")).not.toBe(identity.accountKey("worker-b"));
    expect(identity.countAccounts(["worker-a", "worker-b"])).toBe(2);
  });

  it("refuses to group on thin evidence: one matching window is not enough", () => {
    const identity = createAccountIdentity();
    const single = [{ window: WINDOW_SEVEN_DAY, usedPct: 77, resetsAt: WEEKLY_RESET }];
    identity.reportUsage("claude", single);
    identity.reportUsage("claude-personal", single);

    expect(identity.accountKey("claude")).not.toBe(identity.accountKey("claude-personal"));
    expect(identity.countAccounts(["claude", "claude-personal"])).toBe(2);
  });

  it("ungroups when readings stop proving the match, rather than keeping a stale merge", () => {
    const identity = createAccountIdentity();
    identity.reportUsage("claude", sharedReadings(31, 77));
    identity.reportUsage("claude-personal", sharedReadings(31, 77));
    expect(identity.countAccounts(["claude", "claude-personal"])).toBe(1);

    identity.reportUsage("claude-personal", [{ window: WINDOW_SEVEN_DAY, usedPct: null, resetsAt: null }]);
    expect(identity.countAccounts(["claude", "claude-personal"])).toBe(2);
  });

  it("counts a provider that never reported usage as its own account", () => {
    const identity = createAccountIdentity();
    expect(identity.countAccounts(["worker-a", "worker-b"])).toBe(2);
    expect(identity.siblings("worker-a")).toEqual(["worker-a"]);
  });
});
