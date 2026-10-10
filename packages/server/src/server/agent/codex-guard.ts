import { lstatSync, readlinkSync } from "node:fs";
import nodePath from "node:path";

import {
  checkCatastrophe,
  formatCatastropheDenial,
  resolveCurrentBranchWithGit,
  type CurrentBranchResolver,
} from "./catastrophe-gate.js";
import type { DeviceLaunchGate } from "./device-lease-manager.js";
import { commandName, walkShellCommands, type ExpandedWord } from "./shell-commands.js";

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
  // Review finding #3: a ~/.ssh/config `Host * ProxyCommand ...` stanza runs arbitrary shell on
  // the next ssh or git-over-ssh call, which is not itself a catastrophe-gate pattern. The whole
  // directory is sensitive, not just config -- authorized_keys and the private keys live there
  // too.
  if (segments.includes(".ssh")) {
    return "a path inside a .ssh directory";
  }
  return null;
}

// Verify re-review finding #2 (round 2): resolving an already-dangling symlink (its target does
// not exist yet) requires an lstat+readlink hop, not realpathSync -- realpathSync throws on the
// whole chain the moment the final target is missing, with no way to recover the target it was
// pointing at. A hop limit (incremented once per symlink actually followed, not per path
// component) is the fail-closed backstop against a symlink cycle.
const MAX_SYMLINK_RESOLUTION_HOPS = 40;

/** `absolutePath`'s own root and the rest of its components, in order, with no empty segments. */
function splitAbsolutePath(absolutePath: string): { root: string; segments: string[] } {
  const { root } = nodePath.parse(absolutePath);
  const segments = absolutePath
    .slice(root.length)
    .split(nodePath.sep)
    .filter((segment) => segment.length > 0);
  return { root, segments };
}

/**
 * The sensitivity check above keys on the literal reported path string -- a symlink planted at
 * an ordinary in-workspace path (never itself gated, since in-workspace writes raise no approval
 * request at all) can redirect an always-accepted write into a sensitive location with a name
 * that never matches (review finding #2). Resolves to what the path will actually touch on disk
 * with an explicit component-by-component walk: a queue of remaining path components, each
 * `lstat`-ed against the real location built up so far. A component that doesn't exist ends the
 * walk -- nothing past it can be a symlink, so the rest is appended literally. A component that
 * is a symlink is `readlink`-ed, and the target's own components (absolute: restart from `/`;
 * relative: resolved against the symlink's own directory) are pushed onto the FRONT of the
 * queue, so every one of them -- and everything already queued after the symlink -- gets
 * `lstat`-ed again from scratch. A fixed substitution that stops re-walking the remaining
 * components (an earlier, broken version of this function) misses a second symlink anywhere
 * past the first one found: an ordinary symlinked ancestor (macOS's `/tmp` -> `/private/tmp`, or
 * a symlinked home directory) would otherwise shadow an attack symlink further down the same
 * path. `cwd` is resolved the same way before a relative `rawPath` is joined onto it, so a
 * symlinked workspace root is covered too, not only the path requested within it. Returns null
 * when resolution fails for any reason, or exceeds the symlink-hop limit -- the caller declines
 * on an unresolved path rather than assume it is safe.
 */
export function resolveGuardedFileChangePath(rawPath: string, cwd: string): string | null {
  try {
    if (nodePath.isAbsolute(rawPath)) {
      return resolveFollowingSymlinks(rawPath);
    }
    const resolvedCwd = resolveFollowingSymlinks(cwd);
    if (resolvedCwd === null) {
      return null;
    }
    return resolveFollowingSymlinks(nodePath.resolve(resolvedCwd, rawPath));
  } catch {
    return null;
  }
}

function resolveFollowingSymlinks(absolutePath: string): string | null {
  const { root, segments: remaining } = splitAbsolutePath(absolutePath);
  let resolvedSoFar = root;
  let hops = 0;
  while (remaining.length > 0) {
    const segment = remaining.shift() as string;
    const candidate = nodePath.join(resolvedSoFar, segment);
    let stat;
    try {
      stat = lstatSync(candidate);
    } catch {
      // Nothing exists here yet (the common case for a file apply_patch is about to create) --
      // nothing past this point can be a symlink, so the rest of the path is literal.
      return nodePath.join(candidate, ...remaining);
    }
    if (!stat.isSymbolicLink()) {
      resolvedSoFar = candidate;
      continue;
    }
    hops++;
    if (hops > MAX_SYMLINK_RESOLUTION_HOPS) {
      return null;
    }
    const linkTarget = readlinkSync(candidate);
    const resolvedLinkTarget = nodePath.isAbsolute(linkTarget)
      ? linkTarget
      : nodePath.resolve(resolvedSoFar, linkTarget);
    const { root: targetRoot, segments: targetSegments } = splitAbsolutePath(resolvedLinkTarget);
    resolvedSoFar = targetRoot;
    // The target's own components go back through lstat too -- including whatever was already
    // queued after this symlink, so a second symlink anywhere later in the original path is
    // never skipped.
    remaining.unshift(...targetSegments);
  }
  return resolvedSoFar;
}

/**
 * Everything matching `isSensitiveGitConfigKey` below the alias/hook/helper setters that can
 * later turn an innocuous-looking command (`git pf`, a plain `git fetch`) into one the
 * catastrophe gate's shell parser never sees -- plus the config-based equivalents of running
 * arbitrary code (`include.path`/`includeIf.*.path` load another config file wholesale;
 * `url.*.insteadOf` silently rewrites a URL a later command uses) and `core.fsmonitor`, which
 * git executes as a hook-shaped command on every status check once set.
 */
function isSensitiveGitConfigKey(key: string): boolean {
  const lower = key.trim().toLowerCase();
  return (
    lower.startsWith("alias.") ||
    lower === "core.hookspath" ||
    lower === "core.sshcommand" ||
    lower === "core.fsmonitor" ||
    lower === "include.path" ||
    lower.endsWith(".helper") ||
    (lower.startsWith("includeif.") && lower.endsWith(".path")) ||
    (lower.startsWith("url.") && lower.endsWith(".insteadof"))
  );
}

// `GIT_CONFIG_KEY_0=alias.pf GIT_CONFIG_VALUE_0="push --force origin main" git pf` sets the same
// config through environment variables instead of `-c`, with no "config" token anywhere in the
// command text -- GIT_CONFIG_SENSITIVE_KEY_PATTERN above never sees it. Checked on the key the
// env var names, the same sensitivity test as everywhere else in this file.
const GIT_CONFIG_ENV_KEY_PATTERN = /\bGIT_CONFIG_KEY_\d+\s*=\s*['"]?([^\s'";]+)/gi;

function describeGuardedSensitiveGitConfigEnv(command: string): string | null {
  for (const match of command.matchAll(GIT_CONFIG_ENV_KEY_PATTERN)) {
    const key = match[1];
    if (key && isSensitiveGitConfigKey(key)) {
      return "a GIT_CONFIG_KEY_* environment assignment that sets an alias, hook path, ssh command, or helper";
    }
  }
  return null;
}

/**
 * `checkGit`'s own option-skipping loop (catastrophe-gate.ts) discards `-c key=value` and
 * `--config-env key=var` without ever reading `key` -- so `git -c alias.pf="push --force origin
 * main" pf` sets and invokes the alias in one atomic command, never reaching the literal `push`
 * token `checkGitPush` matches on, and never containing the literal word `config` either (review
 * finding #1). Walking the same shell tokenizer the catastrophe gate uses, this looks at every
 * top-level `git` invocation's own `-c`/`--config-env` options directly, regardless of what
 * subcommand or alias follows. An option whose value cannot be resolved (a substitution, an
 * unexpanded variable) is treated as sensitive too -- the same fail-closed-on-ambiguity rule as
 * everywhere else in this guard.
 */
interface GitConfigOptionMatch {
  /** The option's value text, or null when it is missing or unresolvable. */
  value: string | null;
  /** Whether this option's value lives in the next argument (`-c`/`--config-env`) rather than
   * inline (`--config-env=key=var`), so the caller knows whether to skip it too. */
  consumedNext: boolean;
}

/** `-c key=value`, `--config-env key=var`, or `--config-env=key=var` at `args[index]`; null when
 * `args[index]` is none of those. */
function matchGitConfigOption(args: ExpandedWord[], index: number): GitConfigOptionMatch | null {
  const arg = args[index];
  if (!arg) return null;
  const text = arg.resolved ? arg.text : null;
  if (text !== null && text.startsWith("--config-env=")) {
    return { value: text.slice("--config-env=".length), consumedNext: false };
  }
  if (text === "-c" || text === "--config-env") {
    const valueArg = args[index + 1];
    return { value: valueArg?.resolved ? valueArg.text : null, consumedNext: true };
  }
  return null;
}

// `git config`'s own location/value flags, which take a following argument that is not the key
// (`--file <path>`, `--type <name>`, ...) -- skipped along with their value so the key search
// below does not mistake one for the key.
const GIT_CONFIG_VALUE_FLAGS = new Set(["--file", "-f", "--blob", "--type", "--default"]);

// A read or a removal (`get`/`list`/`unset`/...) never introduces a new value, so neither is a
// vector for this attack regardless of which key it names -- declining one anyway would be a
// pure false positive, not a safety gap, but it's cheap to tell apart here. Covers both the new
// subcommand-verb spelling (git 2.46+) and the long-standing dash-flag spelling of the same
// operations.
const GIT_CONFIG_READ_OR_REMOVE_SUBCOMMANDS = new Set([
  "get",
  "get-all",
  "get-regexp",
  "get-urlmatch",
  "list",
  "unset",
  "unset-all",
  "--get",
  "--get-all",
  "--get-regexp",
  "--get-urlmatch",
  "--list",
  "--unset",
  "--unset-all",
  "-l",
]);

// Verb-shaped tokens that precede the key itself in the new `git config <verb> <key> ...` form
// (git 2.46+) -- skipped so the key search lands on the actual key, not the verb.
const GIT_CONFIG_WRITE_VERBS = new Set(["set", "add", "replace-all"]);

/**
 * The key `git config` (any subcommand form) would set, read, or remove, starting the search
 * right after the `config` token itself; `"unresolvable"` when a token in the key's position
 * can't be resolved (a substitution, an unexpanded variable) rather than a plain value; `null`
 * when this is a pure read or removal (`get`/`list`/`unset`/...) with nothing to flag, or no key
 * position is found
 * at all.
 */
function findGitConfigSubcommandKey(
  args: ExpandedWord[],
  configIndex: number,
): string | "unresolvable" | null {
  for (let index = configIndex + 1; index < args.length; index++) {
    const arg = args[index];
    if (!arg) continue;
    if (!arg.resolved) {
      return "unresolvable";
    }
    const text = arg.text;
    if (GIT_CONFIG_VALUE_FLAGS.has(text)) {
      index++;
      continue;
    }
    if (GIT_CONFIG_READ_OR_REMOVE_SUBCOMMANDS.has(text)) {
      return null;
    }
    if (text.startsWith("-")) {
      continue;
    }
    if (GIT_CONFIG_WRITE_VERBS.has(text)) {
      continue;
    }
    return text;
  }
  return null;
}

export function describeGuardedSensitiveGitInvocation(command: string, cwd: string): string | null {
  let sensitiveReason: string | null = null;
  try {
    walkShellCommands(
      command,
      { cwd, home: null },
      {
        command(args: ExpandedWord[]): boolean {
          const program = args[0];
          if (!program?.resolved || commandName(program.text) !== "git") {
            return false;
          }
          for (let index = 1; index < args.length; index++) {
            const arg = args[index];
            // Review (re-review finding #1): `describeGuardedSensitiveGitConfigCommand`'s old
            // raw-regex scan over the unparsed command text missed a quote-split key
            // (`git config alia""s.pf ...`), which the shell resolves to `alias.pf` but no regex
            // over the literal text ever matches. Routing through the same tokenizer as the
            // `-c`/`--config-env` check below closes it: the key is read from the resolved word,
            // not the raw text.
            if (arg?.resolved && arg.text === "config") {
              const key = findGitConfigSubcommandKey(args, index);
              if (key === "unresolvable") {
                sensitiveReason = "a git config command whose key could not be resolved";
                return true;
              }
              if (key !== null && isSensitiveGitConfigKey(key)) {
                sensitiveReason =
                  "a git config command that sets an alias, hook path, ssh command, or helper";
                return true;
              }
            }
            const match = matchGitConfigOption(args, index);
            if (!match) continue;
            if (match.value === null) {
              // Either the value is unresolvable, or the option's own argument is missing --
              // both are ambiguous enough to decline rather than assume safety.
              sensitiveReason = "a git -c/--config-env option whose value could not be resolved";
              return true;
            }
            const key = match.value.split("=", 1)[0] ?? match.value;
            if (isSensitiveGitConfigKey(key)) {
              sensitiveReason =
                "a git -c/--config-env option that sets an alias, hook path, ssh command, or helper";
              return true;
            }
            if (match.consumedNext) {
              index++;
            }
          }
          return false;
        },
        outputRedirect(): boolean {
          return false;
        },
      },
    );
  } catch {
    // A tokenization failure here is not proof of anything; the caller's own catch-all already
    // declines on error.
  }
  return sensitiveReason;
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
      const gitConfigReason =
        describeGuardedSensitiveGitConfigEnv(input.command) ??
        describeGuardedSensitiveGitInvocation(input.command, input.cwd);
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
