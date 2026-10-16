import type { JevAnswer, JevQuestions } from "../../jev/contract.js";
import { score } from "../../jev/wire.js";
import {
  isSecretShapedPath,
  runJevGit,
  SECRET_PATHSPEC_GLOBS,
  type JevGitRunner,
} from "./jev-file-state.js";

/**
 * `ask_jev_diff_risk` (docs/jev.md, "The tools"): the level-3 code-review risk from
 * disler/ten-levels-of-jev (MIT), with the threshold in code. Add-only (D1): the score may add a
 * full review, never waive one. The diff and the commit messages are written by the agent under
 * review, so nothing in them can lower the answer: every deterministic trigger reads paths and
 * sizes, text that addresses the reviewer is itself a trigger, and a missing answer means review.
 */

export const DIFF_RISK_MAX_DIFF_BYTES = 60_000;
export const DIFF_RISK_MAX_FILES = 20;
export const DIFF_RISK_MAX_LINES = 800;
/** Commit bodies past this are cut with a visible marker: they are the agent's own words. */
const COMMIT_MESSAGE_MAX_CHARS = 6_000;
export const DIFF_RISK_THRESHOLD = 0.5;
/** A security score at or over this (of 2) needs review whatever the weighted risk. */
export const DIFF_RISK_SECURITY_THRESHOLD = 1.5;

export const DIFF_RISK_QUESTIONS: JevQuestions = {
  security_risk: score("How much security risk does `diff` carry?", [
    "No surface touched that handles input, auth, or secrets",
    "Handles input or auth, but follows existing safe patterns",
    "Introduces a plausible injection, secret leak, auth bypass, or invalid token handling",
  ]),
  complexity: score("How complex is the change in `diff`?", [
    "Small, local change in one file, obvious on first read",
    "Touches several files, session handling, or adds branching",
    "Cross-cutting change with subtle invariants",
  ]),
  bad_practice: score("Does `diff` follow the conventions in `diff`'s surrounding context?", [
    "Follows existing patterns cleanly",
    "Minor style drift from surrounding code",
    "Works against the established patterns",
  ]),
  commit_quality: score("Does `commit_message` accurately describe `diff`?", [
    "Vague or unrelated to the change",
    "Names the area but misses key parts of the change",
    "Accurately covers the change: names the fix and the files",
  ]),
};

const WEIGHTS = { security_risk: 0.5, complexity: 0.2, bad_practice: 0.1, commit_quality: 0.2 };

const SENSITIVE_PATH_RE = /auth|secret|crypt|token|permission|password|session/i;
const CI_PATH_RES = [
  /^\.github\/(workflows|actions)\//i,
  /(^|\/)\.gitlab-ci\.ya?ml$/i,
  /^\.circleci\//i,
  /^\.buildkite\//i,
  /(^|\/)Jenkinsfile$/,
  /(^|\/)azure-pipelines\.ya?ml$/i,
  /(^|\/)\.gitea\/workflows\//i,
];
const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "gemfile.lock",
  "poetry.lock",
  "pipfile.lock",
  "uv.lock",
  "composer.lock",
  "go.sum",
  "podfile.lock",
  "package.resolved",
  "gradle.lockfile",
  "flake.lock",
]);
const TEST_PATH_RE =
  /(^|\/)(__tests__|tests?|e2e|spec)\/|\.(test|spec|e2e)\.[^/]+$|_test\.[^/]+$|Tests?\.(swift|kt|java)$/i;

/**
 * Text written to steer a reviewer rather than describe a change, searched in the added lines and
 * the commit messages. Its presence forces review, so hostile text can only raise the answer.
 * Phrases, not identifiers: `score = 0` or "the system prompt" are ordinary code and prose here.
 */
const ADDRESSES_REVIEWER_RES = [
  /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions|prompts?|rules)/i,
  /disregard\s+.{0,40}(instructions|rules|guidelines)/i,
  /\bskip\s+(the\s+)?(full\s+|adversarial\s+)?review\b/i,
  /\bno\s+review\s+(is\s+)?(needed|required)\b/i,
  /\b(low|zero|no)\s+risk,?\s+(approve|merge|ship)\b/i,
  /\byou\s+are\s+(an?\s+)?(ai|assistant|language model|reviewer|jev)\b/i,
  /treat\s+.{0,30}\s+as\s+(safe|trusted|low[- ]risk)/i,
];

function addedLines(patch: string): string {
  return patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .join("\n");
}

export interface DiffRiskParts {
  security_risk: number;
  complexity: number;
  bad_practice: number;
  commit_quality: number;
}

export interface DiffRiskResult {
  /** 0 to 1; null when JEV did not answer. */
  risk: number | null;
  needs_full_review: boolean;
  forced_by: string[];
  parts: DiffRiskParts | null;
  reason: string;
  diff: { base: string; files: number; lines: number; bytes: number } | null;
}

export interface CollectedDiff {
  top: string;
  base: string;
  baseSha: string;
  /** What `base...HEAD` diffs from. */
  mergeBaseSha: string;
  headSha: string;
  paths: Array<{ status: string; path: string }>;
  lines: number;
  diff: string;
  diffBytes: number;
  diffOverCap: boolean;
  commitMessage: string;
}

export type CollectDiffResult = { ok: true; diff: CollectedDiff } | { ok: false; reason: string };

/**
 * Runs git as argv, read-only: no shell, no gate. External diff drivers and textconv are off so a
 * repository's config cannot run a program in the daemon.
 */
export async function collectDiff(input: {
  cwd: string;
  base?: string;
  runGit?: JevGitRunner;
}): Promise<CollectDiffResult> {
  const git = input.runGit ?? runJevGit;
  const top = await git(["rev-parse", "--show-toplevel"], { cwd: input.cwd });
  if (top.code !== 0 || !top.stdout.trim()) return { ok: false, reason: "not a git repository" };
  const cwd = top.stdout.trim();
  const resolved = await resolveBase(git, cwd, input.base?.trim());
  if (!resolved.ok) return resolved;
  const { base, baseSha } = resolved;
  const head = await git(["rev-parse", "--verify", "HEAD"], { cwd });
  if (head.code !== 0) return { ok: false, reason: "git could not resolve HEAD" };
  const mergeBase = await git(["merge-base", baseSha, "HEAD"], { cwd });
  // Exit 1 means the histories share no common ancestor: a real outcome, not a failure, but
  // `A...B` below is defined in terms of that merge base, so every diff/log call that uses it
  // fails the same way. Recorded as its own distinct reason rather than running them to find
  // that out, so this case never reads as the generic "git could not produce the diff" a true
  // failure gets.
  if (mergeBase.code === 1) {
    return { ok: false, reason: `no history in common with ${base}; the histories are unrelated` };
  }
  if (mergeBase.code !== 0) return { ok: false, reason: "git could not produce the diff" };
  const mergeBaseSha = mergeBase.stdout.trim();
  const range = `${baseSha}...HEAD`;
  const common = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"];
  const nameStatus = await git([...common, "--name-status", "-z", range], { cwd });
  const numstat = await git([...common, "--numstat", "-z", range], { cwd });
  // `icase`: pathspecs match case-sensitively even under `core.ignorecase`, and the name check
  // they mirror does not.
  const excludes = SECRET_PATHSPEC_GLOBS.map((glob) => `:(exclude,glob,icase)**/${glob}`);
  const patch = await git([...common, range, "--", ".", ...excludes], { cwd });
  // `log.showSignature` in a repository's config would run its `gpg.program`.
  const log = await git(
    ["log", "--no-color", "--no-show-signature", "--format=%B%x00", `${baseSha}..HEAD`],
    { cwd },
  );
  // Git killed for its buffer or its timeout: that diff is over the cap by any measure.
  const patchTooBig = patch.code === null;
  const failed = [nameStatus, numstat, log].some((result) => result.code !== 0);
  if (failed || (patch.code !== 0 && !patchTooBig)) {
    return { ok: false, reason: "git could not produce the diff" };
  }
  const diffBytes = Buffer.byteLength(patch.stdout, "utf8");
  return {
    ok: true,
    diff: {
      top: cwd,
      base,
      baseSha,
      mergeBaseSha,
      headSha: head.stdout.trim(),
      paths: parseNameStatus(nameStatus.stdout),
      lines: countChangedLines(numstat.stdout),
      diff: patch.stdout,
      diffBytes,
      diffOverCap: patchTooBig || diffBytes > DIFF_RISK_MAX_DIFF_BYTES,
      commitMessage: joinCommitMessages(log.stdout),
    },
  };
}

/**
 * The agent's base, or the upstream, or `origin/HEAD`, as a commit sha. A base that starts with
 * `-` would reach git as an option; `--end-of-options` is the second guard.
 */
async function resolveBase(
  git: JevGitRunner,
  cwd: string,
  requested: string | undefined,
): Promise<{ ok: true; base: string; baseSha: string } | { ok: false; reason: string }> {
  let base = requested;
  if (base) {
    if (base.startsWith("-") || base.includes("\0") || /\s/.test(base)) {
      return { ok: false, reason: `"${base.slice(0, 80)}" is not a branch or commit` };
    }
  } else {
    const upstream = await git(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      { cwd },
    );
    base = upstream.code === 0 && upstream.stdout.trim() ? upstream.stdout.trim() : "origin/HEAD";
  }
  const resolved = await git(
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${base}^{commit}`],
    { cwd },
  );
  const sha = resolved.stdout.trim();
  if (resolved.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
    return { ok: false, reason: `no commit named ${base}; pass base` };
  }
  return { ok: true, base, baseSha: sha };
}

/**
 * The first secret-shaped changed path, from the `--name-status -z` list rather than the patch
 * text: git quotes a path with non-ASCII or control-character bytes in a `diff --git` header
 * (`"caf\303\251/.env"`), so a regex over that text can miss what the NUL-separated list, never
 * quoted, always carries. The pathspec exclusion already keeps a matching file's content out of
 * the patch; this is what refuses to send the diff at all when one is touched.
 */
export function secretShapedChangedPath(diff: CollectedDiff): string | undefined {
  return diff.paths.find((entry) => isSecretShapedPath(entry.path))?.path;
}

function parseNameStatus(stdout: string): Array<{ status: string; path: string }> {
  const fields = stdout.split("\0").filter((entry) => entry.length > 0);
  const paths: Array<{ status: string; path: string }> = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    paths.push({ status: fields[i]!, path: fields[i + 1]! });
  }
  return paths;
}

/** Added plus deleted lines; a binary file (`-`) counts none. */
function countChangedLines(numstat: string): number {
  let lines = 0;
  for (const entry of numstat.split("\0")) {
    const match = /^(\d+|-)\t(\d+|-)\t/.exec(entry);
    if (!match) continue;
    for (const count of [match[1], match[2]]) if (count !== "-") lines += Number(count);
  }
  return lines;
}

function joinCommitMessages(log: string): string {
  const messages = log
    .split("\0")
    .map((message) => message.trim())
    .filter((message) => message.length > 0)
    .join("\n---\n");
  if (messages.length <= COMMIT_MESSAGE_MAX_CHARS) return messages;
  const rest = (messages.length - COMMIT_MESSAGE_MAX_CHARS).toLocaleString("en-US");
  return `${messages.slice(0, COMMIT_MESSAGE_MAX_CHARS)}\n[${rest} more characters of commit messages not sent]`;
}

/** The triggers that force review whatever JEV says. Paths and sizes, plus reviewer-steering text. */
export function deterministicTriggers(diff: CollectedDiff): string[] {
  const forced = new Set<string>();
  for (const { status, path: changed } of diff.paths) {
    const lower = changed.toLowerCase();
    const base = lower.split("/").pop() ?? lower;
    if (SENSITIVE_PATH_RE.test(changed)) forced.add(`sensitive path: ${changed}`);
    if (lower.startsWith("packages/protocol/")) forced.add("protocol package changed");
    if (CI_PATH_RES.some((re) => re.test(changed))) forced.add(`CI or workflow file: ${changed}`);
    if (LOCKFILE_NAMES.has(base)) forced.add(`lockfile: ${changed}`);
    if (base === "persisted-config.ts") forced.add(`persisted config: ${changed}`);
    if (status.startsWith("D") && TEST_PATH_RE.test(changed))
      forced.add(`deleted test: ${changed}`);
    if (isSecretShapedPath(changed)) forced.add(`secret-shaped file changed: ${changed}`);
  }
  if (diff.paths.length > DIFF_RISK_MAX_FILES) {
    forced.add(`more than ${DIFF_RISK_MAX_FILES} files (${diff.paths.length})`);
  }
  if (diff.lines > DIFF_RISK_MAX_LINES) {
    forced.add(`more than ${DIFF_RISK_MAX_LINES} changed lines (${diff.lines})`);
  }
  if (diff.diffOverCap) forced.add("diff over 60 KB");
  const text = `${addedLines(diff.diff)}\n${diff.commitMessage}`;
  if (ADDRESSES_REVIEWER_RES.some((re) => re.test(text))) {
    forced.add("text addressing the reviewer in the diff or commit messages");
  }
  return [...forced];
}

function normalizedScore(answer: JevAnswer | undefined, levels: number): number | null {
  if (answer?.type !== "score") return null;
  return Math.min(1, Math.max(0, answer.score / (levels - 1)));
}

const ADD_ONLY_NOTE =
  "This can only add review: needs_full_review false never means skip the review your process requires.";

/**
 * The verdict. `answers` is null when JEV did not answer; `forcedBy` is `deterministicTriggers`.
 * Nothing JEV returns can turn a trigger off.
 */
export function scoreDiffRisk(input: {
  answers: Record<string, JevAnswer> | null;
  forcedBy: string[];
  unansweredReason?: string;
}): Pick<DiffRiskResult, "risk" | "needs_full_review" | "forced_by" | "parts" | "reason"> {
  const forcedBy = [...input.forcedBy];
  const answers = input.answers;
  const security = normalizedScore(answers?.["security_risk"], 3);
  const complexity = normalizedScore(answers?.["complexity"], 3);
  const badPractice = normalizedScore(answers?.["bad_practice"], 3);
  const commitQuality = normalizedScore(answers?.["commit_quality"], 3);
  if (security === null || complexity === null || badPractice === null || commitQuality === null) {
    forcedBy.push(
      `JEV did not answer${input.unansweredReason ? ` (${input.unansweredReason})` : ""}`,
    );
    return {
      risk: null,
      needs_full_review: true,
      forced_by: forcedBy,
      parts: null,
      reason: `Needs full review: ${forcedBy.join("; ")}. ${ADD_ONLY_NOTE}`,
    };
  }
  const risk =
    WEIGHTS.security_risk * security +
    WEIGHTS.complexity * complexity +
    WEIGHTS.bad_practice * badPractice +
    WEIGHTS.commit_quality * (1 - commitQuality);
  const rounded = Math.round(risk * 1000) / 1000;
  const securityScore =
    answers?.["security_risk"]?.type === "score" ? answers["security_risk"].score : 0;
  const reasons = [...forcedBy];
  if (risk >= DIFF_RISK_THRESHOLD)
    reasons.push(`risk ${rounded} is at or over ${DIFF_RISK_THRESHOLD}`);
  if (securityScore >= DIFF_RISK_SECURITY_THRESHOLD) {
    reasons.push(
      `security_risk ${Math.round(securityScore * 100) / 100} is at or over ${DIFF_RISK_SECURITY_THRESHOLD}`,
    );
  }
  const needsFullReview = reasons.length > 0;
  return {
    risk: rounded,
    needs_full_review: needsFullReview,
    forced_by: forcedBy,
    parts: {
      security_risk: round3(security),
      complexity: round3(complexity),
      bad_practice: round3(badPractice),
      commit_quality: round3(commitQuality),
    },
    reason: needsFullReview
      ? `Needs full review: ${reasons.join("; ")}. ${ADD_ONLY_NOTE}`
      : `No trigger fired and the risk ${rounded} is under ${DIFF_RISK_THRESHOLD}. ${ADD_ONLY_NOTE}`,
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
