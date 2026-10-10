import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import nodePath from "node:path";

import {
  checkCatastrophe,
  formatCatastropheDenial,
  resolveCurrentBranchWithGit,
  type CurrentBranchResolver,
} from "./catastrophe-gate.js";
import type { DeviceLaunchGate } from "./device-lease-manager.js";
import { commandName, walkShellCommands, type ExpandedWord } from "./shell-commands.js";
import { comparableName } from "../jev/secret-paths.js";

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

// Verify finding #1 (round 3): macOS (APFS/HFS+ default) and Windows volumes are
// case-insensitive, so `.GIT`/`.Git`/`.SSH` land on the same directory as `.git`/`.ssh`.
// Comparing lowercased segments is strictly more inclusive than exact comparison, never less: on
// a case-sensitive volume this flags nothing a case-sensitive check would have missed, and
// catches the case-insensitive-volume write a case-sensitive check otherwise would.
//
// Verify finding (round 5): an NTFS name alias reaches the same file under a different-looking
// name -- a trailing dot/space (`.git.`, `.git `) or an alternate-data-stream suffix
// (`.git::$INDEX_ALLOCATION`) that Windows drops when it opens the file. `comparableName`
// (jev/secret-paths.ts, shared rather than reimplemented here per docs/jev.md Feature 16 step 7)
// already strips exactly this, plus Unicode compatibility folding, for the same reason the JEV
// read check needs it: a secret (or here, sensitive) file name built to look different to a
// naive string comparison is still the same file to the OS.
function pathSegments(path: string): string[] {
  return comparableName(path)
    .toLowerCase()
    .split("/")
    .filter((segment) => segment.length > 0);
}

// Verify finding (round 5): NTFS also auto-generates an 8.3 "short name" alias for a long file
// name -- `.git` can be addressed as `GIT~1`, `.gitconfig` as `GITCON~1` -- with no reliable way
// to compute the exact alias without asking the filesystem (which short-name collision a given
// directory landed on). Declining any component shaped like `<1-6 chars>~<digits>` whose prefix
// is a case-insensitive prefix of a sensitive name (dot removed) is a heuristic, not an exact
// 8.3 implementation, but false positives here cost nothing -- stricter is fine.
const EIGHT_DOT_THREE_ALIAS_PATTERN = /^(.{1,6})~\d+$/;

function eightDotThreeAliasReason(segment: string): string | null {
  const match = EIGHT_DOT_THREE_ALIAS_PATTERN.exec(segment);
  if (!match) {
    return null;
  }
  const prefix = (match[1] ?? "").toLowerCase();
  const sensitiveNamesWithoutDot = [
    "git",
    "gitconfig",
    "gitattributes",
    "ssh",
    ...Array.from(SHELL_RC_BASENAMES, (name) => name.replace(/^\./, "")),
  ];
  const matchedName = sensitiveNamesWithoutDot.find((name) => name.startsWith(prefix));
  return matchedName
    ? `an 8.3 short-name alias of .${matchedName} (NTFS can address it as ${segment.toUpperCase()})`
    : null;
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

  for (const segment of segments) {
    const eightDotThreeReason = eightDotThreeAliasReason(segment);
    if (eightDotThreeReason) {
      return eightDotThreeReason;
    }
  }

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

/**
 * `rawPath`'s own root (empty when relative) and the rest of its components, in original order,
 * with no empty segments -- but `.`/`..` are left in place, not collapsed. `path.resolve`/
 * `path.join` collapse `..` against whatever segment happens to precede it in the TEXT, with no
 * idea whether that segment is a real directory or a symlink (review finding #3): `objlink/..`
 * textually cancels to nothing, silently assuming `objlink` is transparent, when `..` after a
 * symlink must instead go to the PARENT OF WHATEVER THE SYMLINK'S TARGET RESOLVED TO. Splitting
 * without collapsing, and only ever resolving `..` against the real, already-substituted
 * location inside the walk below, is what keeps that distinction intact.
 *
 * Verify finding (round 6, P0): splits on `\` only when `platform` is `"win32"`. `\` is an
 * ordinary filename character on POSIX, not a separator -- splitting on it unconditionally (an
 * earlier version of this function did) let a single real component literally named
 * `zz\..\..\..` be torn into four fake navigation segments ("zz", "..", "..", ".."), walking the
 * resolver somewhere the real kernel -- which sees one opaque name with backslashes in it, and
 * resolves the REAL `..` after it normally -- never goes. `platform` defaults to
 * `process.platform` and is a parameter (not read directly) so a test can exercise the win32
 * branch from any host.
 */
function splitRawSegments(rawPath: string, platform: NodeJS.Platform): string[] {
  const { root } = nodePath.parse(rawPath);
  const separators = platform === "win32" ? /[\\/]/ : /\//;
  return rawPath
    .slice(root.length)
    .split(separators)
    .filter((segment) => segment.length > 0 && segment !== ".");
}

// Verify re-review finding #2 (round 2): resolving an already-dangling symlink (its target does
// not exist yet) requires an lstat+readlink hop, not realpathSync -- realpathSync throws on the
// whole chain the moment the final target is missing, with no way to recover the target it was
// pointing at. A hop limit (incremented once per symlink actually followed, not per path
// component) is the fail-closed backstop against a symlink cycle.
const MAX_SYMLINK_RESOLUTION_HOPS = 40;

/**
 * The sensitivity check above keys on the literal reported path string -- a symlink planted at
 * an ordinary in-workspace path (never itself gated, since in-workspace writes raise no approval
 * request at all) can redirect an always-accepted write into a sensitive location with a name
 * that never matches (review finding #2). Resolves to what the path will actually touch on disk
 * with an explicit component-by-component walk: a queue of remaining path components, each
 * `lstat`-ed against the real location built up so far. A component that doesn't exist is NOT
 * treated as the end of the walk (an earlier version of this function returned early here,
 * appending everything still queued as text -- wrong, because a later `..` can still pop back
 * past a missing component to a real ancestor, and a later component can still be a real symlink
 * that needs following: `newdir/../hooklink/x`, where `newdir` never exists and `hooklink` is a
 * real symlink, must still follow `hooklink`). A missing component is pushed onto the resolved
 * stack like any ordinary non-symlink name and the walk continues. A component that
 * is a symlink is `readlink`-ed, and the target's own components (absolute: restart from the
 * root; relative: resolved against the symlink's own directory, which is exactly the location
 * already built up) are pushed onto the FRONT of the queue, so every one of them -- and
 * everything already queued after the symlink, `..` included -- gets `lstat`-ed (or, for `..`,
 * popped against the real location) again from scratch. A fixed substitution that stops
 * re-walking the remaining components (an earlier, broken version of this function) misses a
 * second symlink anywhere past the first one found: an ordinary symlinked ancestor (macOS's
 * `/tmp` -> `/private/tmp`, or a symlinked home directory) would otherwise shadow an attack
 * symlink further down the same path. `cwd` is resolved the same way before a relative `rawPath`
 * is joined onto it -- never via `path.resolve`, which would collapse a `..` in `rawPath` against
 * `cwd`'s own un-substituted text (review finding #3) -- so a symlinked workspace root is
 * covered too, not only the path requested within it. Returns null when resolution fails for any
 * reason, or exceeds the symlink-hop limit -- the caller declines on an unresolved path rather
 * than assume it is safe.
 */
export function resolveGuardedFileChangePath(
  rawPath: string,
  cwd: string,
  // Verify finding (round 6): injectable so a test can exercise the win32-only branches
  // (backslash-as-separator, trailing-dot/space stripping) from any host.
  platform: NodeJS.Platform = process.platform,
): string | null {
  try {
    if (nodePath.isAbsolute(rawPath)) {
      return walkSegments(
        nodePath.parse(rawPath).root,
        splitRawSegments(rawPath, platform),
        platform,
      );
    }
    const resolvedCwd = walkSegments(
      nodePath.parse(cwd).root,
      splitRawSegments(cwd, platform),
      platform,
    );
    if (resolvedCwd === null) {
      return null;
    }
    return walkSegments(resolvedCwd, splitRawSegments(rawPath, platform), platform);
  } catch {
    return null;
  }
}

/**
 * Verify finding (round 6, P1): win32 drops a trailing dot or space when it opens a file --
 * `hooklink.` and `hooklink` are the same file to the OS -- but `lstatSync`/`readlinkSync` read
 * the literal name and get `ENOENT` for the dotted/spaced form, so the walker saw a "missing"
 * component instead of the real symlink/junction underneath and never followed it. Stripped
 * before every `lstat`/`readlink` call on win32, the same normalization Win32 itself applies.
 * Left as-is if stripping would empty the segment entirely (an all-dots/all-spaces name is not
 * what this is for).
 */
function stripWin32TrailingDotsAndSpaces(segment: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") {
    return segment;
  }
  const stripped = segment.replace(/[. ]+$/, "");
  return stripped.length > 0 ? stripped : segment;
}

function walkSegments(
  startResolved: string,
  segments: string[],
  platform: NodeJS.Platform,
): string | null {
  let resolvedSoFar = startResolved;
  const remaining = [...segments];
  let hops = 0;
  while (remaining.length > 0) {
    const segment = remaining.shift() as string;
    if (segment === "..") {
      // Popped against the real location built up so far, not the original (possibly
      // symlinked) text -- the whole point of finding #3's fix.
      resolvedSoFar = nodePath.dirname(resolvedSoFar);
      continue;
    }
    const effectiveSegment = stripWin32TrailingDotsAndSpaces(segment, platform);
    const candidate = nodePath.join(resolvedSoFar, effectiveSegment);
    // Verify finding #2 (round 4): a missing component must NOT end the walk early. A later `..`
    // can still pop back past it to a real ancestor, and a later component can still be a real
    // symlink that needs following -- `newdir/../hooklink/post-checkout` (newdir never existing,
    // hooklink a real symlink to .git/hooks) must still follow hooklink. Earlier code returned
    // here on a missing component, textually appending everything still queued -- exactly the
    // same premature-text-collapse mistake finding #3 fixed for `..`, just for the "doesn't
    // exist" case instead. A missing component is treated as an ordinary (non-symlink) name on
    // the resolved stack: nothing special, just not a substitution target itself.
    let stat;
    try {
      stat = lstatSync(candidate);
    } catch {
      stat = null;
    }
    if (!stat) {
      resolvedSoFar = candidate;
      continue;
    }
    // Verify finding (round 5): on win32, an existing component may be addressable under an
    // NTFS 8.3 short-name alias (`GIT~1`) that the heuristic sensitivity check above can only
    // guess at -- realpathSync.native asks the OS for the real long name directly, resolving
    // short-name aliases and reparse points (symlinks/junctions) in the same call. Tried only
    // when the component already exists (it cannot do anything for a not-yet-existing target);
    // falls through to the manual lstat/readlink handling below on any failure.
    if (platform === "win32") {
      try {
        resolvedSoFar = realpathSync.native(candidate);
        continue;
      } catch {
        // Fall through.
      }
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
    if (nodePath.isAbsolute(linkTarget)) {
      resolvedSoFar = nodePath.parse(linkTarget).root;
    }
    // A relative target resolves against the symlink's own directory -- resolvedSoFar, right
    // now, before this hop, is exactly that directory (fully resolved already, with every
    // component already verified real) -- so it needs no change for that case.
    remaining.unshift(...splitRawSegments(linkTarget, platform));
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
  const lower = key.trim().normalize("NFC").toLowerCase();
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
