import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { AgentPermissionRequest } from "../agent/agent-sdk-types.js";
import {
  findCompanyMarker,
  findExcludedAction,
  findExcludedActions,
  isReadOnlyPermission,
} from "./safety.js";
import {
  BENIGN_PHRASES,
  CONTROL_PHRASES,
  DODGE_PHRASES,
  DODGE_UNICODE_PHRASES,
} from "./test-utils/dodge-phrases.js";

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
    ["git reset --hard origin/main to clean up?", "git-history"],
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
    ["Run it with sudo?", "privilege"],
  ])("blocks %j as %s", (text, category) => {
    expect(findExcludedActions(text)).toContain(category);
  });

  it.each([
    "Option A: add the retry in the client. Option B: add it in the server. Which do you prefer?",
    "The tests pass. I will keep going with the refactor of the parser.",
    "Tokens used this week are up 12%; the budget pacing looks fine.",
    "Should I use a dropdown or a segmented control for the filter?",
    "I kept the hotkey and changed the label text. Continue with the docs?",
    ...BENIGN_PHRASES,
  ])("lets %j through", (text) => {
    expect(findExcludedActions(text)).toEqual([]);
  });

  it("names every rule a text trips, for the log", () => {
    expect(findExcludedActions("merge then deploy")).toEqual(["merge", "release"]);
  });
});

describe("the adversarial review's dodge phrases (appendix B)", () => {
  // Before the fix, 64 of these 67 got through; now every one is caught.
  it.each(DODGE_PHRASES)("catches %j", (phrase) => {
    expect(findExcludedAction(phrase)).not.toBeNull();
  });

  it.each(DODGE_UNICODE_PHRASES)("catches the Unicode spelling %j", (phrase) => {
    expect(findExcludedAction(phrase)).not.toBeNull();
  });

  it.each(CONTROL_PHRASES)("still catches the control %j", (phrase) => {
    expect(findExcludedAction(phrase)).not.toBeNull();
  });

  it("covers the whole table", () => {
    expect(DODGE_PHRASES).toHaveLength(67);
  });

  it.each([
    ["mеrge (Cyrillic е)", "mеrge the PR"],
    ["ⅿerge (a lookalike not in the fold table)", "ⅿerge the PR"],
    ["dеlеtе with an Armenian letter", "dեlete it"],
  ])("reads %s as a hit", (_name, text) => {
    expect(findExcludedActions(text).length).toBeGreaterThan(0);
  });

  it("reads a word mixing scripts as obfuscated even with no rule behind it", () => {
    expect(findExcludedActions("please pаtch the parser")).toEqual(["obfuscated"]);
  });

  it.each([
    "PASEO_JEV_API_KEY",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "GITHUB_TOKEN",
    "STRIPE_SECRET",
  ])("catches the credential name %s", (name) => {
    expect(findExcludedActions(`set ${name} for the pool`)).toContain("credentials");
  });
});

describe("findCompanyMarker", () => {
  it.each([
    ["the Wonderly app", "wonderly"],
    ["see backend-net#10032", "backend-net"],
    ["in ts-monorepo", "ts-monorepo"],
    ["~/mobile-worktrees/app", "mobile-worktrees"],
    ["push to wondergit", "wondergit"],
    ["lease a WonderPod", "wonderpod"],
    ["motion_net", "motion-net"],
    ["/Users/x/.paseo/worktrees/1rlfnz6g/main", "1rlfnz6g"],
  ])("finds %j", (text, name) => {
    expect(findCompanyMarker(text)).toBe(name);
  });

  it("finds nothing in Bozeo work", () => {
    expect(findCompanyMarker("~/paseo-worktrees/jev-away-reply, the Bozeo daemon")).toBeNull();
  });
});

describe("isReadOnlyPermission", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "away-reply-safety-"));
  const cwd = path.join(root, "work");
  const home = path.join(root, "home");
  mkdirSync(path.join(cwd, "src"), { recursive: true });
  mkdirSync(path.join(cwd, ".github"), { recursive: true });
  mkdirSync(path.join(home, ".ssh"), { recursive: true });
  mkdirSync(path.join(home, ".config", "gh"), { recursive: true });
  writeFileSync(path.join(cwd, "src", "parser.ts"), "export {};");
  writeFileSync(path.join(cwd, ".env.local"), "SECRET=1");
  writeFileSync(path.join(cwd, "server.pem"), "pem");
  writeFileSync(path.join(cwd, ".github", "ci.yml"), "ci");
  writeFileSync(path.join(home, ".ssh", "id_ed25519"), "key");
  writeFileSync(path.join(home, ".config", "gh", "hosts.yml"), "token");
  symlinkSync(path.join(home, ".ssh"), path.join(cwd, "keys"));
  const scope = { cwd, home };
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it.each([
    ["Read", { file_path: path.join(cwd, "src", "parser.ts") }],
    ["Read", { file_path: "src/parser.ts", offset: 10, limit: 20 }],
    ["NotebookRead", { notebook_path: "src/parser.ts" }],
    ["LS", { path: path.join(cwd, "src") }],
    ["LS", {}],
    ["Glob", { pattern: "src/**/*.ts" }],
    ["Grep", { pattern: "export", path: "src/parser.ts", output_mode: "content" }],
  ])("allows %s %j inside the leader's cwd", (name, input) => {
    expect(isReadOnlyPermission(toolRequest(name, input), scope)).toBe(true);
  });

  // The review's table (B3): each passed the first allowlist. Bash is never approved now.
  it.each([
    "find ~/important -de''lete",
    'find . -del""ete',
    "find . '-delete'",
    "find . '-fprint' ~/.zshrc",
    "find . -fpr''int x",
    "find . -exec rm {} ;",
    "find . -ok rm {} ;",
    "find . -fls out",
    "find . -fprintf out %p",
    "rg --pre sh . payload",
    "rg --pre=./x.sh foo",
    "tree -o ~/.zshrc",
    "file -C -m x",
    "date 0101000030",
    "cat ~/.ssh/id_ed25519",
    "cat ~/.config/gh/hosts.yml",
    "git status",
    "ls",
  ])("never approves Bash: %j", (command) => {
    expect(isReadOnlyPermission(toolRequest("Bash", { command }), scope)).toBe(false);
  });

  it.each([
    ["Read", { file_path: "~/.ssh/id_ed25519" }],
    ["Read", { file_path: path.join(home, ".config", "gh", "hosts.yml") }],
    ["Read", { file_path: "keys/id_ed25519" }],
    ["Read", { file_path: ".env.local" }],
    ["Read", { file_path: "server.pem" }],
    ["Read", { file_path: ".github/ci.yml" }],
    ["Read", { file_path: "../home/.ssh/id_ed25519" }],
    ["Read", { file_path: "/etc/hosts" }],
    ["Read", { file_path: "~/.paseo/daemon-keypair.json" }],
    ["Read", { file_path: "~/.claude-personal/.credentials.json" }],
    ["Read", {}],
    ["Read", { file_path: "src/parser.ts", extra: "x" }],
    ["LS", { path: "~/.ssh" }],
    ["LS", { path: "/" }],
    ["Glob", { pattern: "**/.env*" }],
    ["Glob", { pattern: "../**/*" }],
    ["Glob", { pattern: "/Users/**/*.pem" }],
    ["Glob", { pattern: "*.ts", path: "~/.ssh" }],
    ["Grep", { pattern: "token", path: "src" }],
    ["Grep", { pattern: "token" }],
    ["Grep", { pattern: "token", path: "src/parser.ts", glob: "*" }],
  ])("refuses %s %j", (name, input) => {
    expect(isReadOnlyPermission(toolRequest(name, input), scope)).toBe(false);
  });

  it("refuses writes, web tools, MCP tools and non-tool requests", () => {
    for (const name of [
      "Write",
      "Edit",
      "WebFetch",
      "WebSearch",
      "mcp__github__merge_pull_request",
    ]) {
      expect(isReadOnlyPermission(toolRequest(name, { file_path: "src/parser.ts" }), scope)).toBe(
        false,
      );
    }
    expect(
      isReadOnlyPermission(
        { id: "q", provider: "claude", name: "AskUserQuestion", kind: "question", input: {} },
        scope,
      ),
    ).toBe(false);
  });
});
