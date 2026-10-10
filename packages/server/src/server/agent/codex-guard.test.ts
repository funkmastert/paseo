import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  decideCodexGuardedCommand,
  describeGuardedSensitiveFileChangePath,
  describeGuardedSensitiveGitInvocation,
  resolveGuardedFileChangePath,
} from "./codex-guard.js";
import type { DeviceLaunchGate, DeviceLaunchGateDecision } from "./device-lease-manager.js";

const REPO = "/Users/tester/code/app";

function fakeBranchResolver(branch = "main") {
  return async () => branch;
}

function fakeDeviceGate(decision: DeviceLaunchGateDecision): DeviceLaunchGate {
  return {
    gateLaunch: async () => decision,
  };
}

function throwingDeviceGate(): DeviceLaunchGate {
  return {
    gateLaunch: async () => {
      throw new Error("device gate exploded");
    },
  };
}

describe("decideCodexGuardedCommand", () => {
  test("declines a catastrophic command with the catastrophe reason", async () => {
    const result = await decideCodexGuardedCommand({
      command: "git push --force origin main",
      cwd: REPO,
      agentId: "agent-1",
      deviceLaunchGate: undefined,
      resolveCurrentBranch: fakeBranchResolver("main"),
    });
    expect(result.decision).toBe("decline");
    expect(result.reason).toContain("force-push-main");
  });

  test("declines when the device gate denies, with the device-gate reason", async () => {
    const result = await decideCodexGuardedCommand({
      command: "npm test",
      cwd: REPO,
      agentId: "agent-1",
      deviceLaunchGate: fakeDeviceGate({ decision: "deny", message: "no device slot" }),
      resolveCurrentBranch: fakeBranchResolver("feature/x"),
    });
    expect(result).toEqual({ decision: "decline", reason: "no device slot" });
  });

  test("approves an ordinary command when both gates clear", async () => {
    const result = await decideCodexGuardedCommand({
      command: "npm test",
      cwd: REPO,
      agentId: "agent-1",
      deviceLaunchGate: fakeDeviceGate({ decision: "allow" }),
      resolveCurrentBranch: fakeBranchResolver("feature/x"),
    });
    expect(result).toEqual({ decision: "accept" });
  });

  test("approves when there is no device gate wired at all", async () => {
    const result = await decideCodexGuardedCommand({
      command: "npm test",
      cwd: REPO,
      agentId: "agent-1",
      deviceLaunchGate: undefined,
      resolveCurrentBranch: fakeBranchResolver("feature/x"),
    });
    expect(result).toEqual({ decision: "accept" });
  });

  test("declines when the catastrophe check throws", async () => {
    const result = await decideCodexGuardedCommand({
      command: "git push --force origin main",
      cwd: REPO,
      agentId: "agent-1",
      deviceLaunchGate: undefined,
      resolveCurrentBranch: async () => {
        throw new Error("git exploded");
      },
    });
    expect(result.decision).toBe("decline");
  });

  test("declines when the device gate throws", async () => {
    const result = await decideCodexGuardedCommand({
      command: "npm test",
      cwd: REPO,
      agentId: "agent-1",
      deviceLaunchGate: throwingDeviceGate(),
      resolveCurrentBranch: fakeBranchResolver("feature/x"),
    });
    expect(result.decision).toBe("decline");
  });

  test("skips the catastrophe check when the kill switch is off, and still runs the device gate", async () => {
    const result = await decideCodexGuardedCommand({
      command: "git push --force origin main",
      cwd: REPO,
      agentId: "agent-1",
      deviceLaunchGate: fakeDeviceGate({ decision: "deny", message: "no device slot" }),
      isCatastropheGateEnabled: () => false,
      resolveCurrentBranch: fakeBranchResolver("main"),
    });
    expect(result).toEqual({ decision: "decline", reason: "no device slot" });
  });

  test("approves when the catastrophe kill switch is off and no device gate is wired", async () => {
    const result = await decideCodexGuardedCommand({
      command: "git push --force origin main",
      cwd: REPO,
      agentId: "agent-1",
      deviceLaunchGate: undefined,
      isCatastropheGateEnabled: () => false,
      resolveCurrentBranch: fakeBranchResolver("main"),
    });
    expect(result).toEqual({ decision: "accept" });
  });

  test("declines a git alias setup, closing the alias blind spot (review finding #2)", async () => {
    const result = await decideCodexGuardedCommand({
      command: "git config alias.pf 'push --force origin main'",
      cwd: REPO,
      agentId: "agent-1",
      deviceLaunchGate: undefined,
      resolveCurrentBranch: fakeBranchResolver("main"),
    });
    expect(result.decision).toBe("decline");
    expect(result.reason).toContain("git-alias-setup");
  });

  test("skips the git-alias check too when the catastrophe kill switch is off", async () => {
    const result = await decideCodexGuardedCommand({
      command: "git config alias.pf 'push --force origin main'",
      cwd: REPO,
      agentId: "agent-1",
      deviceLaunchGate: undefined,
      isCatastropheGateEnabled: () => false,
      resolveCurrentBranch: fakeBranchResolver("main"),
    });
    expect(result).toEqual({ decision: "accept" });
  });
});

describe("describeGuardedSensitiveFileChangePath", () => {
  test.each([
    ["/workspace/project/.git/config", "a path inside a .git directory"],
    ["/workspace/project/.git/hooks/pre-commit", "a path inside a .git directory"],
    ["/workspace/project/.gitconfig", "a git config file"],
    ["/workspace/project/.config/git/config", "a git config file"],
    [
      "/workspace/project/.gitattributes",
      "a .gitattributes file (can declare a filter driver that runs arbitrary commands)",
    ],
    ["/workspace/project/.zshrc", "a shell startup file"],
    ["/workspace/project/.bashrc", "a shell startup file"],
  ])("flags %s", (path, expectedReason) => {
    expect(describeGuardedSensitiveFileChangePath(path)).toBe(expectedReason);
  });

  test.each([
    "/workspace/project/src/index.ts",
    "/workspace/project/README.md",
    "/workspace/project/gitattributes-notes.md",
  ])("clears an ordinary path: %s", (path) => {
    expect(describeGuardedSensitiveFileChangePath(path)).toBeNull();
  });
});

describe("describeGuardedSensitiveGitInvocation -- git config subcommand (verify finding #1)", () => {
  test.each([
    ["legacy form", "git config alias.pf 'push --force origin main'"],
    ["--global flag", "git config --global alias.pf 'push --force origin main'"],
    ["core.hooksPath", "git config core.hooksPath /tmp/evil-hooks"],
    ["core.sshCommand", "git config core.sshCommand 'ssh -i /tmp/evil-key'"],
    ["core.fsmonitor", "git config core.fsmonitor /tmp/evil-fsmonitor"],
    ["credential.helper", "git config credential.helper '!/tmp/evil-helper'"],
    ["diff.helper", "git config diff.helper /tmp/evil-diff-helper"],
    ["include.path", "git config include.path /tmp/evil-include"],
    ["includeIf.*.path", "git config includeIf.onbranch:main.path /tmp/evil-include"],
    ["url.*.insteadOf", "git config url.https://evil.example/.insteadOf https://github.com/"],
    ["new `config set` subcommand form", "git config set alias.pf 'push --force origin main'"],
    [
      "quote-split key (re-review finding #1's confirmed bypass)",
      `git config alia""s.pf 'push --force origin main'`,
    ],
    ["quote-split key, single quotes", `git config alia''s.pf 'push --force origin main'`],
    ["case-variant key", "git config ALIAS.pf 'push --force origin main'"],
    ["case-variant well-known key", "git config Core.HooksPath /tmp/evil-hooks"],
  ])("flags: %s -- %s", (_label, command) => {
    expect(describeGuardedSensitiveGitInvocation(command, REPO)).not.toBeNull();
  });

  test.each([
    "git status",
    "git config user.name test",
    "git config --get remote.origin.url",
    "git config --get alias.pf",
    "git config get alias.pf",
    "git config --list",
    "git config unset alias.pf",
    "npm config set registry https://example.com",
  ])("clears: %s", (command) => {
    expect(describeGuardedSensitiveGitInvocation(command, REPO)).toBeNull();
  });

  test("the quote-split bypass is declined end-to-end by decideCodexGuardedCommand", async () => {
    const result = await decideCodexGuardedCommand({
      command: `git config alia""s.pf 'push --force origin main'`,
      cwd: REPO,
      agentId: "agent-1",
      deviceLaunchGate: undefined,
      resolveCurrentBranch: fakeBranchResolver("main"),
    });
    expect(result.decision).toBe("decline");
  });

  test("a later plain invocation of an alias set this way is also declined on its own (defense in depth)", async () => {
    // Even if the alias-setting step were somehow missed, checkCatastrophe's own pattern match
    // never resolves aliases -- this asserts only that `git pf` alone, with no -c/config/alias
    // setup in the same command, is NOT caught by this specific check (it relies on the setup
    // step being declined, per docs/catastrophe-gate.md's documented gap). Documents the
    // boundary rather than asserting a false guarantee.
    expect(describeGuardedSensitiveGitInvocation("git pf", REPO)).toBeNull();
  });
});

describe("describeGuardedSensitiveGitInvocation (re-review finding #1)", () => {
  test.each([
    `git -c alias.pf="push --force origin main" pf`,
    `git -c alias.pf='push --force origin main' pf`,
    "git -c core.hooksPath=/tmp/evil-hooks status",
    "git -c core.sshCommand='ssh -i /tmp/evil-key' fetch",
    "git -c credential.helper=!/tmp/evil-helper fetch",
    "git --config-env=alias.pf=SOME_VAR pf",
    "git --config-env alias.pf=SOME_VAR pf",
  ])("flags the atomic set-and-invoke bypass: %s", (command) => {
    expect(describeGuardedSensitiveGitInvocation(command, REPO)).not.toBeNull();
  });

  test.each([
    "git status",
    "git -c user.name=test commit -m x",
    "git -c core.pager=cat log",
    "git --config-env=user.name=SOME_VAR commit -m x",
    "npm -c alias.pf=x run build",
  ])("clears an ordinary invocation: %s", (command) => {
    expect(describeGuardedSensitiveGitInvocation(command, REPO)).toBeNull();
  });

  test("the atomic bypass is declined end-to-end by decideCodexGuardedCommand", async () => {
    const result = await decideCodexGuardedCommand({
      command: `git -c alias.pf="push --force origin main" pf`,
      cwd: REPO,
      agentId: "agent-1",
      deviceLaunchGate: undefined,
      resolveCurrentBranch: fakeBranchResolver("main"),
    });
    expect(result.decision).toBe("decline");
  });

  test("a GIT_CONFIG_KEY_* env-var alias setup is declined end-to-end", async () => {
    const result = await decideCodexGuardedCommand({
      command:
        'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.pf GIT_CONFIG_VALUE_0="push --force origin main" git pf',
      cwd: REPO,
      agentId: "agent-1",
      deviceLaunchGate: undefined,
      resolveCurrentBranch: fakeBranchResolver("main"),
    });
    expect(result.decision).toBe("decline");
  });
});

describe("describeGuardedSensitiveFileChangePath (.ssh, re-review finding #3)", () => {
  test.each([
    "/workspace/project/.ssh/config",
    "/workspace/project/.ssh/authorized_keys",
    "/home/x/.ssh/id_rsa",
  ])("flags %s", (sshPath) => {
    expect(describeGuardedSensitiveFileChangePath(sshPath)).not.toBeNull();
  });

  test("clears an ordinary path with 'ssh' in its name but not a .ssh directory", () => {
    expect(describeGuardedSensitiveFileChangePath("/workspace/project/ssh-notes.md")).toBeNull();
  });
});

describe("describeGuardedSensitiveFileChangePath -- case and Unicode insensitivity (verify finding #1, round 3)", () => {
  test.each([
    "/workspace/project/.GIT/HOOKS/post-update",
    "/workspace/project/.Git/hooks/post-update",
    "/workspace/project/.git/Hooks/post-update",
    "/workspace/project/.GITCONFIG",
    "/workspace/project/.GitAttributes",
    "/workspace/project/.SSH/config",
    "/workspace/project/.ssh/Config",
    "/workspace/project/.ZSHRC",
    "/workspace/project/.ZshRC",
  ])("flags a case-variant sensitive path on a case-insensitive volume: %s", (path) => {
    expect(describeGuardedSensitiveFileChangePath(path)).not.toBeNull();
  });

  test("still clears an ordinary path regardless of case", () => {
    expect(describeGuardedSensitiveFileChangePath("/workspace/project/NOTES.MD")).toBeNull();
  });
});

describe("resolveGuardedFileChangePath (re-review finding #2)", () => {
  let scratch: string;

  beforeEach(() => {
    // realpathSync's own normalization, so the test's expectations match on a machine where
    // the OS temp dir itself is a symlink (/var -> /private/var on macOS).
    scratch = realpathSync(mkdtempSync(nodePath.join(os.tmpdir(), "codex-guard-resolve-test-")));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  test("resolves a plain existing file to itself", () => {
    const file = nodePath.join(scratch, "notes.md");
    writeFileSync(file, "hello");
    expect(resolveGuardedFileChangePath("notes.md", scratch)).toBe(file);
  });

  test("resolves a non-existent file to its reconstructed absolute path", () => {
    const file = nodePath.join(scratch, "new-file.md");
    expect(resolveGuardedFileChangePath("new-file.md", scratch)).toBe(file);
  });

  test("follows a symlink file target to its real path", () => {
    mkdirSync(nodePath.join(scratch, ".git"), { recursive: true });
    const gitConfig = nodePath.join(scratch, ".git", "config");
    writeFileSync(gitConfig, "[core]\n");
    const link = nodePath.join(scratch, "notes.md");
    symlinkSync(gitConfig, link);

    const resolved = resolveGuardedFileChangePath("notes.md", scratch);
    expect(resolved).toBe(gitConfig);
    expect(describeGuardedSensitiveFileChangePath(resolved ?? "")).not.toBeNull();
  });

  test("follows a symlinked directory ancestor to its real path", () => {
    const realDir = nodePath.join(scratch, "real-target");
    mkdirSync(nodePath.join(realDir, ".git"), { recursive: true });
    const gitConfig = nodePath.join(realDir, ".git", "config");
    writeFileSync(gitConfig, "[core]\n");
    const linkDir = nodePath.join(scratch, "evil-link");
    symlinkSync(realDir, linkDir);

    // The target file under the symlinked directory doesn't exist yet -- resolution must still
    // follow the directory symlink and reconstruct the remaining segment.
    const resolved = resolveGuardedFileChangePath(
      nodePath.join("evil-link", ".git", "config"),
      scratch,
    );
    expect(resolved).toBe(gitConfig);
    expect(describeGuardedSensitiveFileChangePath(resolved ?? "")).not.toBeNull();
  });

  test("follows a dangling symlink to its not-yet-existing sensitive target (verify finding #2's confirmed bypass)", () => {
    mkdirSync(nodePath.join(scratch, ".git", "hooks"), { recursive: true });
    const hookTarget = nodePath.join(scratch, ".git", "hooks", "post-checkout");
    // The hook file does not exist yet -- this is the exact bypass string from the verification
    // report: `ln -s .git/hooks/post-checkout evil-hook-link.md` before the target exists, then
    // apply_patch "creates" evil-hook-link.md, writing through the dangling link.
    const link = nodePath.join(scratch, "evil-hook-link.md");
    symlinkSync(".git/hooks/post-checkout", link);
    expect(existsSync(hookTarget)).toBe(false);

    const resolved = resolveGuardedFileChangePath("evil-hook-link.md", scratch);
    expect(resolved).toBe(hookTarget);
    expect(describeGuardedSensitiveFileChangePath(resolved ?? "")).not.toBeNull();
  });

  test("follows a dangling symlink whose own directory does not exist yet either", () => {
    // Nothing under scratch/.git exists at all -- the link, its target's directory, and its
    // target are all dangling/non-existent, only the link itself is real.
    const hookTarget = nodePath.join(scratch, ".git", "hooks", "post-checkout");
    const link = nodePath.join(scratch, "evil-hook-link.md");
    symlinkSync(".git/hooks/post-checkout", link);

    const resolved = resolveGuardedFileChangePath("evil-hook-link.md", scratch);
    expect(resolved).toBe(hookTarget);
    expect(describeGuardedSensitiveFileChangePath(resolved ?? "")).not.toBeNull();
  });

  test("the dangling-symlink bypass is declined end-to-end through describeGuardedSensitiveFileChangePath", () => {
    mkdirSync(nodePath.join(scratch, ".ssh"), { recursive: true });
    const sshConfigTarget = nodePath.join(scratch, ".ssh", "config");
    const link = nodePath.join(scratch, "innocuous-notes.md");
    symlinkSync(".ssh/config", link);
    expect(existsSync(sshConfigTarget)).toBe(false);

    const resolved = resolveGuardedFileChangePath("innocuous-notes.md", scratch);
    expect(resolved).toBe(sshConfigTarget);
    expect(describeGuardedSensitiveFileChangePath(resolved ?? "")).not.toBeNull();
    // The literal reported name alone -- what the old implementation fell back to -- is not
    // sensitive; only resolution reveals it.
    expect(describeGuardedSensitiveFileChangePath("innocuous-notes.md")).toBeNull();
  });

  test("returns null (declines) on a symlink cycle rather than looping forever", () => {
    const linkA = nodePath.join(scratch, "a");
    const linkB = nodePath.join(scratch, "b");
    symlinkSync(linkB, linkA);
    symlinkSync(linkA, linkB);

    expect(resolveGuardedFileChangePath("a", scratch)).toBeNull();
  });

  test("resolves `..` against the symlink's real target directory, not the symlink's own location (verify finding #3, round 3)", () => {
    // objlink's target is nested two levels below scratch, so "objlink/.." landing on scratch
    // itself (what a naive path.resolve/path.normalize text collapse would produce, treating
    // objlink as if it were just its own name) is a different, wrong answer from the correct
    // one (the target's real parent, one level below scratch).
    const nestedDir = nodePath.join(scratch, "alpha", "beta");
    mkdirSync(nestedDir, { recursive: true });
    const objlink = nodePath.join(scratch, "objlink");
    symlinkSync(nestedDir, objlink);

    // Built with plain "/" concatenation, not nodePath.join -- path.join would itself collapse
    // "objlink/.." textually before resolveGuardedFileChangePath ever saw it, defeating the
    // point of this test.
    const resolved = resolveGuardedFileChangePath("objlink/../hooks/x", scratch);
    expect(resolved).toBe(nodePath.join(scratch, "alpha", "hooks", "x"));
  });

  test("the objlink/../hooks/x bypass is declined end-to-end -- a naive text collapse would miss the sensitive ancestor entirely (verify finding #3, round 3)", () => {
    // objlink's target lives inside a REAL .git directory; "hooks/post-update" (the suffix)
    // never spells ".git" anywhere in the rawPath string itself -- only correctly following the
    // symlink before applying ".." reveals that the ancestor is sensitive.
    const nestedDir = nodePath.join(scratch, ".git", "beta");
    mkdirSync(nestedDir, { recursive: true });
    const objlink = nodePath.join(scratch, "objlink");
    symlinkSync(nestedDir, objlink);

    // Same caution as above: plain "/" concatenation, not nodePath.join.
    const resolved = resolveGuardedFileChangePath("objlink/../hooks/post-update", scratch);
    expect(resolved).toBe(nodePath.join(scratch, ".git", "hooks", "post-update"));
    expect(describeGuardedSensitiveFileChangePath(resolved ?? "")).not.toBeNull();

    // What a naive path.resolve/path.normalize-before-the-walk collapse would have produced
    // instead -- provably NOT sensitive, confirming this is a real verdict change (an accept
    // that should be a decline), not just a differently-shaped sensitive string.
    const naiveCollapse = nodePath.join(scratch, "hooks", "post-update");
    expect(describeGuardedSensitiveFileChangePath(naiveCollapse)).toBeNull();
  });

  test("a relative symlink target containing its own `..` resolves relative to the symlink's own directory", () => {
    const realDir = nodePath.join(scratch, "real-target");
    mkdirSync(nodePath.join(realDir, ".git"), { recursive: true });
    const gitDir = nodePath.join(realDir, ".git");
    const nested = nodePath.join(scratch, "nested");
    mkdirSync(nested, { recursive: true });
    const relLink = nodePath.join(nested, "rel-link");
    // Relative target: from `nested/`, "../real-target" is scratch/real-target.
    symlinkSync(nodePath.join("..", "real-target"), relLink);

    const resolved = resolveGuardedFileChangePath(
      nodePath.join("nested", "rel-link", ".git"),
      scratch,
    );
    expect(resolved).toBe(gitDir);
    expect(describeGuardedSensitiveFileChangePath(resolved ?? "")).not.toBeNull();
  });
});

describe("resolveGuardedFileChangePath -- an earlier symlinked ancestor does not shadow a deeper attack symlink (verify finding #2, round 2)", () => {
  // The regression: the broken version substituted an earlier symlinked ancestor (macOS's own
  // /tmp -> /private/tmp, or a symlinked home directory) and then appended everything after it
  // as a literal string, never lstat-ing it again -- so an attack symlink further down the same
  // path was never inspected. These tests deliberately do NOT realpath the workspace path
  // passed to resolveGuardedFileChangePath (unlike the describe block above, whose shared
  // `scratch` is realpathed up front and so never exercised this path).
  let realBase: string;
  let ancestorLink: string;

  beforeEach(() => {
    // Canonicalized once, so expected values below are exact -- the symlink actually under test
    // is ancestorLink, created fresh below and never realpathed before use.
    realBase = realpathSync(mkdtempSync(nodePath.join(os.tmpdir(), "codex-guard-real-base-")));
    ancestorLink = `${realBase}-link`;
    symlinkSync(realBase, ancestorLink);
  });

  afterEach(() => {
    rmSync(ancestorLink, { force: true });
    rmSync(realBase, { recursive: true, force: true });
  });

  test("resolves an attack symlink reached through a symlinked ancestor, not just the ancestor itself", () => {
    mkdirSync(nodePath.join(realBase, ".git", "hooks"), { recursive: true });
    const hookTarget = nodePath.join(realBase, ".git", "hooks", "post-checkout");
    symlinkSync(".git/hooks/post-checkout", nodePath.join(realBase, "evil-hook-link.md"));
    expect(existsSync(hookTarget)).toBe(false);

    // ancestorLink itself is a symlink to realBase, and is passed in as-is (not pre-realpathed)
    // -- the PoC the verifier reproduced via /tmp/... (accepted, before this fix) vs
    // /private/tmp/... (declined).
    const resolved = resolveGuardedFileChangePath("evil-hook-link.md", ancestorLink);
    expect(resolved).toBe(hookTarget);
    expect(describeGuardedSensitiveFileChangePath(resolved ?? "")).not.toBeNull();
  });

  test("resolves an ordinary path reached through a symlinked ancestor to its real, non-sensitive location", () => {
    const resolved = resolveGuardedFileChangePath("notes.md", ancestorLink);
    expect(resolved).toBe(nodePath.join(realBase, "notes.md"));
    expect(describeGuardedSensitiveFileChangePath(resolved ?? "")).toBeNull();
  });

  test("resolves cwd itself through the symlinked ancestor before joining the relative path", () => {
    writeFileSync(nodePath.join(realBase, "notes.md"), "hello");
    // No path segment here is itself a symlink past the ancestor -- this isolates that cwd
    // resolution alone (not just the per-segment walk) follows the ancestor link.
    const resolved = resolveGuardedFileChangePath("notes.md", ancestorLink);
    expect(resolved).toBe(nodePath.join(realBase, "notes.md"));
  });

  test("a symlinked home-like ancestor two levels up still exposes a sensitive symlink nested further inside", () => {
    // home -> realBase; workspace is a real directory *inside* home, reached only through the
    // ancestor link -- simulates a symlinked home directory with an ordinary project checkout
    // underneath it, not just a symlinked workspace root itself.
    const homeLink = ancestorLink;
    mkdirSync(nodePath.join(realBase, "project", ".ssh"), { recursive: true });
    const sshConfigTarget = nodePath.join(realBase, "project", ".ssh", "config");
    symlinkSync(".ssh/config", nodePath.join(realBase, "project", "innocuous-notes.md"));
    expect(existsSync(sshConfigTarget)).toBe(false);

    const workspace = nodePath.join(homeLink, "project");
    const resolved = resolveGuardedFileChangePath("innocuous-notes.md", workspace);
    expect(resolved).toBe(sshConfigTarget);
    expect(describeGuardedSensitiveFileChangePath(resolved ?? "")).not.toBeNull();
  });
});
