import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { normalizeClaudeContextUsage } from "./context-usage.js";

// Real `get_context_usage` control responses from live SDK sessions (CLI 2.1.280), with the
// display-only `gridRows` dropped. opus-1m resumes a 174K-token session; haiku-200k is a fresh
// session with deferred tool schemas.
function fixture(name: string): SDKControlGetContextUsageResponse {
  const url = new URL(`./test-fixtures/${name}`, import.meta.url);
  return { gridRows: [], ...JSON.parse(readFileSync(url, "utf8")) };
}

const CAPTURED_AT = "2026-09-24T23:21:54.742Z";

describe("normalizeClaudeContextUsage", () => {
  test("keeps the provider's rows, adds the autocompact buffer, and shrinks free space by it", () => {
    const usage = normalizeClaudeContextUsage(fixture("context-usage-opus-1m.json"), CAPTURED_AT);

    expect(usage).toEqual({
      provider: "claude",
      model: "claude-opus-5-5[1m]",
      capturedAt: CAPTURED_AT,
      source: "session",
      totalTokens: 174085,
      maxTokens: 1000000,
      categories: [
        { id: "system_prompt", label: "System prompt", tokens: 248, kind: "used" },
        { id: "system_tools", label: "System tools", tokens: 23754, kind: "used" },
        { id: "memory_files", label: "Memory files", tokens: 13437, kind: "used" },
        { id: "skills", label: "Skills", tokens: 8626, kind: "used" },
        { id: "messages", label: "Messages", tokens: 130302, kind: "used" },
        { id: "autocompact_buffer", label: "Autocompact buffer", tokens: 33000, kind: "buffer" },
        { id: "free_space", label: "Free space", tokens: 790633, kind: "free" },
      ],
      memoryFiles: [
        {
          path: "/Users/tylerthackray/.claude-personal/CLAUDE.md",
          type: "User",
          tokens: 3976,
        },
        {
          path: "/Users/tylerthackray/.paseo/worktrees/3jvw4yw6/cpu-policing/CLAUDE.md",
          type: "Project",
          tokens: 8580,
        },
        {
          path: "/Users/tylerthackray/.claude-personal/projects/-Users-tylerthackray-paseo/memory/MEMORY.md",
          type: "AutoMem",
          tokens: 881,
        },
      ],
      messageBreakdown: {
        toolCallTokens: 3417,
        toolResultTokens: 59559,
        attachmentTokens: 44060,
        assistantMessageTokens: 27234,
        userMessageTokens: 973,
      },
    });
  });

  test("marks deferred tool schemas as outside the window", () => {
    const usage = normalizeClaudeContextUsage(
      fixture("context-usage-haiku-200k.json"),
      CAPTURED_AT,
    );

    expect(usage.categories).toEqual([
      { id: "system_prompt", label: "System prompt", tokens: 203, kind: "used" },
      { id: "system_tools", label: "System tools", tokens: 14157, kind: "used" },
      {
        id: "system_tools_deferred",
        label: "System tools (deferred)",
        tokens: 15940,
        kind: "deferred",
      },
      { id: "memory_files", label: "Memory files", tokens: 9488, kind: "used" },
      { id: "skills", label: "Skills", tokens: 1986, kind: "used" },
      { id: "messages", label: "Messages", tokens: 8, kind: "used" },
      { id: "autocompact_buffer", label: "Autocompact buffer", tokens: 33000, kind: "buffer" },
      { id: "free_space", label: "Free space", tokens: 141158, kind: "free" },
    ]);
    expect(usage.totalTokens).toBe(25842);
    expect(usage.maxTokens).toBe(200000);
  });

  test("adds no buffer when autocompact is off", () => {
    const raw = { ...fixture("context-usage-haiku-200k.json"), isAutoCompactEnabled: false };

    const usage = normalizeClaudeContextUsage(raw, CAPTURED_AT);

    expect(usage.categories.map((row) => row.id)).not.toContain("autocompact_buffer");
    expect(usage.categories.at(-1)).toEqual({
      id: "free_space",
      label: "Free space",
      tokens: 174158,
      kind: "free",
    });
  });

  test("keeps a buffer row the CLI reports itself instead of deriving a second one", () => {
    const raw = fixture("context-usage-haiku-200k.json");
    raw.categories = [
      ...raw.categories.filter((row) => row.name !== "Free space"),
      { name: "Autocompact buffer", tokens: 45000, color: "inactive" },
      { name: "Free space", tokens: 129158, color: "promptBorder" },
    ];

    const usage = normalizeClaudeContextUsage(raw, CAPTURED_AT);

    expect(usage.categories.filter((row) => row.kind === "buffer")).toEqual([
      { id: "autocompact_buffer", label: "Autocompact buffer", tokens: 45000, kind: "buffer" },
    ]);
    expect(usage.categories.at(-1)?.tokens).toBe(129158);
  });

  test("never reports negative free space when the session is past the threshold", () => {
    const raw = fixture("context-usage-haiku-200k.json");
    raw.categories = raw.categories.map((row) =>
      row.name === "Free space" ? { ...row, tokens: 20000 } : row,
    );

    const usage = normalizeClaudeContextUsage(raw, CAPTURED_AT);

    expect(usage.categories.find((row) => row.kind === "buffer")?.tokens).toBe(20000);
    expect(usage.categories.find((row) => row.kind === "free")?.tokens).toBe(0);
  });

  test("names MCP and custom-agent rows by their slug", () => {
    const raw = fixture("context-usage-haiku-200k.json");
    raw.categories = [
      { name: "MCP tools", tokens: 4100, color: "cyan" },
      { name: "MCP tools (deferred)", tokens: 9000, color: "cyan", isDeferred: true },
      { name: "Custom agents", tokens: 740, color: "permission" },
    ];

    const usage = normalizeClaudeContextUsage(raw, CAPTURED_AT);

    expect(usage.categories.slice(0, 3)).toEqual([
      { id: "mcp_tools", label: "MCP tools", tokens: 4100, kind: "used" },
      { id: "mcp_tools_deferred", label: "MCP tools (deferred)", tokens: 9000, kind: "deferred" },
      { id: "custom_agents", label: "Custom agents", tokens: 740, kind: "used" },
    ]);
  });
});
