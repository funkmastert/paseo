import { describe, expect, it } from "vitest";

import type { AgentPermissionRequest } from "../agent/agent-sdk-types.js";
import {
  findExcludedAction,
  findExcludedActions,
  isReadOnlyPermission,
  isReadOnlyShellCommand,
} from "./safety.js";

function toolRequest(name: string, input: Record<string, unknown> = {}): AgentPermissionRequest {
  return { id: "perm-1", provider: "claude", name, kind: "tool", input };
}

describe("findExcludedAction", () => {
  it.each([
    ["Should I merge PR #12?", "merge"],
    ["Ready for approval to merge once CI is green", "merge"],
    ["Enable auto-merge on the branch?", "merge"],
    ["I can force push the rebased branch", "force-push"],
    ["Run git push origin fix --force?", "force-push"],
    ["Want me to delete the old worktrees?", "destructive"],
    ["I'll remove the stale cache directory", "destructive"],
    ["Wipe the scratch database and start over?", "destructive"],
    ["Drop the migrations table?", "destructive"],
    ["git reset --hard origin/main to clean up?", "destructive"],
    ["rm -rf node_modules and reinstall?", "destructive"],
    ["The OpenRouter API key needs rotating", "credentials"],
    ["Please revoke the leaked GitHub token", "credentials"],
    ["You need to log in to the Claude account again", "credentials"],
    ["Where are the credentials for staging?", "credentials"],
    ["Deploy the site now?", "release"],
    ["Cut a release of 0.9.2?", "release"],
    ["Publish the package to npm?", "release"],
    ["git tag v1.2.0 and push tags?", "release"],
    ["Pay the invoice for the extra seats?", "payment"],
    ["Buy another Claude Max subscription plan?", "payment"],
    ["Raise the spend limit on the account?", "payment"],
    ["Relaunch Bozeo to pick up the build?", "restart"],
    ["Restart the daemon on 6767?", "restart"],
    ["Post a summary in the team Slack channel?", "outward-message"],
    ["Reply to the reviewer on the PR thread?", "outward-message"],
    ["Open a PR for this branch?", "outward-message"],
    ["Should I git push the fix?", "outward-message"],
    ["Email the customer with the results?", "outward-message"],
  ])("blocks %j as %s", (text, category) => {
    expect(findExcludedAction(text)?.category).toBe(category);
  });

  it.each([
    "Option A: add the retry in the client. Option B: add it in the server. Which do you prefer?",
    "The tests pass. I will keep going with the refactor of the parser.",
    "Tokens used this week are up 12%; the budget pacing looks fine.",
    "Should I use a dropdown or a segmented control for the filter?",
    "I kept the hotkey and changed the label text. Continue with the docs?",
  ])("lets %j through", (text) => {
    expect(findExcludedAction(text)).toBeNull();
  });

  it("names every rule a text trips, for the log", () => {
    expect(findExcludedActions("merge then deploy")).toEqual(["merge", "release"]);
  });
});

describe("isReadOnlyShellCommand", () => {
  it.each([
    "ls -la",
    "cat package.json",
    "rg -n foo packages/server",
    "git status",
    "git -C /tmp/repo log --oneline -5",
    "git diff HEAD~1",
    "git branch --show-current",
    "git remote -v",
    "find . -name '*.ts'",
    "wc -l src/index.ts",
  ])("allows %j", (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(true);
  });

  it.each([
    "rm -rf dist",
    "npm install",
    "git push",
    "git branch -D old",
    "git remote add origin x",
    "git checkout main",
    "find . -name x -delete",
    "find . -exec rm {} ;",
    "cat a > b",
    "ls; rm x",
    "ls && rm x",
    "cat $(echo x)",
    "echo `whoami`",
    "git diff --output=/tmp/x",
    "",
  ])("refuses %j", (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(false);
  });
});

describe("isReadOnlyPermission", () => {
  it("allows read-only tools and read-only Bash", () => {
    expect(isReadOnlyPermission(toolRequest("Read", { file_path: "/tmp/x" }))).toBe(true);
    expect(isReadOnlyPermission(toolRequest("Grep", { pattern: "x" }))).toBe(true);
    expect(isReadOnlyPermission(toolRequest("Bash", { command: "git status" }))).toBe(true);
  });

  it("refuses writes, web tools, MCP tools and non-tool requests", () => {
    expect(isReadOnlyPermission(toolRequest("Edit", { file_path: "/tmp/x" }))).toBe(false);
    expect(isReadOnlyPermission(toolRequest("Write", { file_path: "/tmp/x" }))).toBe(false);
    expect(isReadOnlyPermission(toolRequest("WebFetch", { url: "https://x" }))).toBe(false);
    expect(isReadOnlyPermission(toolRequest("mcp__paseo__list_agents"))).toBe(false);
    expect(isReadOnlyPermission(toolRequest("Bash", { command: "npm test" }))).toBe(false);
    expect(isReadOnlyPermission(toolRequest("Bash"))).toBe(false);
    expect(isReadOnlyPermission({ ...toolRequest("Read"), kind: "plan" })).toBe(false);
  });
});
