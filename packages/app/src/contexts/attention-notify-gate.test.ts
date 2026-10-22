import { describe, expect, it } from "vitest";

import {
  shouldOsNotifyAgentAttention,
  shouldOsNotifyTerminalAttention,
} from "./attention-notify-gate";

describe("shouldOsNotifyAgentAttention", () => {
  it("always notifies for a permission request", () => {
    expect(shouldOsNotifyAgentAttention({ reason: "permission", isQuestion: false })).toBe(true);
  });

  it("never notifies for an error", () => {
    expect(shouldOsNotifyAgentAttention({ reason: "error", isQuestion: false })).toBe(false);
    expect(shouldOsNotifyAgentAttention({ reason: "error", isQuestion: true })).toBe(false);
  });

  it("does not notify an ordinary finish", () => {
    expect(shouldOsNotifyAgentAttention({ reason: "finished", isQuestion: false })).toBe(false);
  });

  it("notifies a finish flagged as a question", () => {
    expect(shouldOsNotifyAgentAttention({ reason: "finished", isQuestion: true })).toBe(true);
  });
});

describe("shouldOsNotifyTerminalAttention", () => {
  it("notifies a terminal waiting on input", () => {
    expect(shouldOsNotifyTerminalAttention("needs_input")).toBe(true);
  });

  it("does not notify a finished terminal", () => {
    expect(shouldOsNotifyTerminalAttention("finished")).toBe(false);
  });
});
