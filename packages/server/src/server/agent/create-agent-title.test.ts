import { describe, expect, test } from "vitest";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { getLatestUserMessageText } from "./create-agent-title.js";

describe("getLatestUserMessageText", () => {
  test("returns the most recent non-empty user message", () => {
    const items: AgentTimelineItem[] = [
      { type: "user_message", text: "first" },
      { type: "assistant_message", text: "reply" },
      { type: "user_message", text: "second" },
    ];

    expect(getLatestUserMessageText(items)).toBe("second");
  });

  test("trims whitespace on the matched message", () => {
    const items: AgentTimelineItem[] = [{ type: "user_message", text: "  padded  " }];

    expect(getLatestUserMessageText(items)).toBe("padded");
  });

  test("skips a trailing empty user message and returns the prior one", () => {
    const items: AgentTimelineItem[] = [
      { type: "user_message", text: "real instruction" },
      { type: "user_message", text: "   " },
    ];

    expect(getLatestUserMessageText(items)).toBe("real instruction");
  });

  test("returns null when there are no user messages", () => {
    const items: AgentTimelineItem[] = [{ type: "assistant_message", text: "hello" }];

    expect(getLatestUserMessageText(items)).toBeNull();
  });

  test("returns null for an empty timeline", () => {
    expect(getLatestUserMessageText([])).toBeNull();
  });
});
