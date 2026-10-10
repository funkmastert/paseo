import {
  checkCatastrophe,
  formatCatastropheDenial,
  resolveCurrentBranchWithGit,
  type CurrentBranchResolver,
} from "./catastrophe-gate.js";
import type { DeviceLaunchGate } from "./device-lease-manager.js";

export interface CodexGuardDecision {
  decision: "accept" | "decline";
  reason?: string;
}

const SHELL_RC_BASENAMES = new Set([
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zlogin",
  ".zlogout",
  ".profile",
  ".cshrc",
  ".tcshrc",
  ".kshrc",
  ".login",
  ".inputrc",
]);

function pathSegments(path: string): string[] {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0);
}

/**
 * A guarded Codex child's apply_patch channel is otherwise unconditionally accepted (no
 * catastrophe-gate coverage for file writes, matching Claude). These paths are the ones through
 * which a pure file write can later weaponize an "ordinary" shell command the catastrophe gate's
 * shell parser would otherwise catch -- a `.git/config` alias, a hook, a `.gitattributes` filter
 * driver, or a shell rc file sourced on the next interactive shell (docs/catastrophe-gate.md).
 */
export function describeGuardedSensitiveFileChangePath(path: string): string | null {
  const segments = pathSegments(path);
  const basename = segments[segments.length - 1] ?? "";

  if (segments.includes(".git")) {
    return "a path inside a .git directory";
  }
  if (basename === ".gitconfig") {
    return "a git config file";
  }
  // $XDG_CONFIG_HOME/git/config -- same shape regardless of where XDG_CONFIG_HOME points; the
  // .git/config case above already covers the in-repo location.
  if (basename === "config" && segments[segments.length - 2] === "git") {
    return "a git config file";
  }
  if (basename === ".gitattributes") {
    return "a .gitattributes file (can declare a filter driver that runs arbitrary commands)";
  }
  if (SHELL_RC_BASENAMES.has(basename)) {
    return "a shell startup file";
  }
  return null;
}

// Matches `alias.<name>`, `core.hooksPath`, `core.sshCommand`, or any `<section>.helper` key as a
// `git config` argument -- the alias/hook/helper setters that can later turn an innocuous-looking
// command (`git pf`, a plain `git fetch`) into one the catastrophe gate's shell parser never sees.
const GIT_CONFIG_SENSITIVE_KEY_PATTERN =
  /(?:^|[\s'"])(alias\.[^\s'"=]+|core\.hookspath|core\.sshcommand|[^\s'"=]+\.helper)(?=[\s'"=]|$)/i;

/**
 * The catastrophe gate's shell parser resolves push/force/delete tokens literally and does not
 * resolve git aliases (docs/catastrophe-gate.md's documented gap). A guarded Codex child must not
 * be able to set up that blind spot in the first place: decline any `git config` invocation that
 * sets an alias, a hook path, an ssh command, or a credential/diff/merge helper, regardless of
 * what the alias or helper would do.
 */
export function describeGuardedSensitiveGitConfigCommand(command: string): string | null {
  if (!/\bgit\b/i.test(command) || !/\bconfig\b/i.test(command)) {
    return null;
  }
  if (GIT_CONFIG_SENSITIVE_KEY_PATTERN.test(command)) {
    return "a git config command that sets an alias, hook path, ssh command, or helper";
  }
  return null;
}

export interface CodexGuardLogger {
  warn: (obj: object, msg?: string) => void;
}

export interface CodexGuardCommandInput {
  command: string;
  cwd: string;
  agentId: string | undefined;
  deviceLaunchGate: DeviceLaunchGate | undefined;
  isCatastropheGateEnabled?: () => boolean;
  resolveCurrentBranch?: CurrentBranchResolver;
  logger?: CodexGuardLogger;
}

/**
 * The one guard decision for a guarded Codex child's command-approval request
 * (docs/catastrophe-gate.md, KTD-5): catastrophe gate first, then the device gate.
 *
 * Declines on any thrown error -- the opposite of Claude's hook, which fails open. A guarded
 * Codex child has no other layer: nothing runs until this function says yes.
 */
export async function decideCodexGuardedCommand(
  input: CodexGuardCommandInput,
): Promise<CodexGuardDecision> {
  try {
    const catastropheEnabled = input.isCatastropheGateEnabled
      ? input.isCatastropheGateEnabled()
      : true;
    if (catastropheEnabled) {
      const decision = await checkCatastrophe(
        input.command,
        input.cwd,
        input.resolveCurrentBranch ?? resolveCurrentBranchWithGit,
      );
      if (decision.block) {
        input.logger?.warn(
          {
            rule: decision.rule,
            agentId: input.agentId,
            provider: "codex",
            cwd: input.cwd,
            command: input.command.slice(0, 500),
          },
          "Catastrophe gate blocked a command",
        );
        return { decision: "decline", reason: formatCatastropheDenial(decision, input.command) };
      }
      const gitConfigReason = describeGuardedSensitiveGitConfigCommand(input.command);
      if (gitConfigReason) {
        input.logger?.warn(
          {
            rule: "git-alias-setup",
            agentId: input.agentId,
            provider: "codex",
            cwd: input.cwd,
            command: input.command.slice(0, 500),
          },
          "Catastrophe gate blocked a git config command",
        );
        return {
          decision: "decline",
          reason: `Blocked by the catastrophe gate (rule: git-alias-setup): this command sets ${gitConfigReason}, which could later be used to bypass the push/force checks.`,
        };
      }
    }

    if (input.deviceLaunchGate && input.agentId) {
      const deviceDecision = await input.deviceLaunchGate.gateLaunch({
        agentId: input.agentId,
        command: input.command,
      });
      if (deviceDecision.decision === "deny") {
        return { decision: "decline", reason: deviceDecision.message };
      }
    }

    return { decision: "accept" };
  } catch (error) {
    input.logger?.warn({ err: error, agentId: input.agentId }, "Codex guard failed; declining");
    return { decision: "decline", reason: "Paseo guard failed; declining to be safe." };
  }
}
