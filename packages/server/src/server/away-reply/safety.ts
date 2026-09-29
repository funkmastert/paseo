import type { AgentPermissionRequest } from "../agent/agent-sdk-types.js";

/**
 * The away auto-reply's hard rules, in code (docs/jev.md, "Feature 14: away auto-reply"). They run
 * before any JEV call and again on the reply about to go out, and JEV cannot override them: a
 * thread that mentions any of these gets no auto-reply, whatever JEV answers.
 *
 * Broad on purpose. A false hit costs one reply Tyler writes himself when he is back; a miss can
 * merge a pull request on his behalf.
 */

export type AwayReplyExclusionCategory =
  | "merge"
  | "force-push"
  | "destructive"
  | "credentials"
  | "release"
  | "payment"
  | "restart"
  | "outward-message";

/** Categories where only Tyler can act, so a hit may raise the agent's attention flag. */
export const TYLER_ONLY_CATEGORIES: ReadonlySet<AwayReplyExclusionCategory> = new Set([
  "credentials",
  "payment",
]);

const EXCLUSION_RULES: ReadonlyArray<{ category: AwayReplyExclusionCategory; pattern: RegExp }> = [
  { category: "merge", pattern: /\b(?:auto-?)?merg(?:e|es|ed|ing|eable)\b/i },
  {
    category: "force-push",
    pattern:
      /\bforce[- ]?push(?:es|ed|ing)?\b|--force-with-lease\b|\bgit\s+push\b[^\n]*\s(?:-f|--force)\b/i,
  },
  {
    category: "destructive",
    pattern:
      /\bdelet(?:e|es|ed|ing|ion)\b|\bremov(?:e|es|ed|ing|al)\b|\bwip(?:e|es|ed|ing)\b|\bdrop(?:s|ped|ping)?\b|\breset\s+--hard\b|\bgit\s+clean\b|\brm\s+-[a-z]*[rf]|\bpurg(?:e|es|ed|ing)\b|\bdestroy|\btruncat|\boverwrit|\bp?kill(?:s|ed|ing)?\b|\birreversibl/i,
  },
  {
    category: "credentials",
    pattern:
      /\bcredential|\bsecrets?\b|\bpasswords?\b|\bpasskeys?\b|\bapi[ _-]?keys?\b|\b(?:access|auth|bearer|oauth|refresh|github|gh|npm|pat|personal[ _-]access|api|jev|openrouter|session)[ _-]?tokens?\b|\btokens?\s+(?:rotation|leak|expir)|\brotat(?:e|es|ed|ing|ion)\b|\brevok|\blog\s?in\b|\blog\s?ged\s+(?:in|out)\b|\bsign\s?in\b|\bre-?auth|\b2fa\b|\bmfa\b|\bssh[ _-]?keys?\b|\bprivate[ _-]?keys?\b|\bkeychain\b|\.env\b/i,
  },
  {
    category: "release",
    pattern:
      /\bdeploy|\breleas(?:e|es|ed|ing)\b|\bpublish|\bgit\s+tag\b|\btag(?:s|ged|ging)?\s+(?:a\s+|the\s+)?(?:v?\d|release|version|build)|\bpush(?:ing)?\s+(?:the\s+)?tags?\b|--tags\b|\bship(?:ping)?\s+(?:it|this|to)\b|\bgo(?:es|ing)?\s+live\b|\broll(?:ing)?\s*out\b|\b(?:to|in|on|into)\s+prod(?:uction)?\b/i,
  },
  {
    category: "payment",
    pattern:
      /\bpay(?:s|ing|ment|ments)?\b|\bpaid\b|\bpurchas|\bbuy(?:s|ing)?\b|\bbilling\b|\binvoic|\bcredit\s+card|\brefund|\bspend(?:ing)?\s+limit|\bextra\s+usage\b|\bsubscription\s+(?:plan|upgrade|renewal)|\bupgrade\s+(?:the\s+|my\s+|your\s+)?plan\b/i,
  },
  {
    category: "restart",
    pattern:
      /\bre-?launch|\brestart|\breboot|\bdaemon\s+(?:reload|stop)\b|\b(?:paseo|bozeo)\s+(?:daemon\s+)?(?:reload|stop)\b/i,
  },
  {
    category: "outward-message",
    pattern:
      /\b(?:send|post|email|e-mail|dm|message|ping|notify|tweet|reply\s+to|respond\s+to|comment\s+(?:on|in))\b[^\n.?!]{0,60}\b(?:slack|email|them|him|her|team|reviewers?|channel|customers?|users?|colleagues?|people|everyone|issue|pr|pull\s+request|thread|discord|twitter|linkedin|andrew)\b|\bslack\b|\be-?mail\b|\btweet|\b(?:open|create|file|raise)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:pr|pull\s+request|issue)\b|\bgh\s+(?:pr|issue)\s+(?:create|comment|review|edit)\b|\bgit\s+push\b|\bpush(?:ing)?\s+(?:it|this|that|them|the\s+branch|the\s+fix|to\s+(?:origin|remote|github|main|master|upstream))\b|\bpost\s+(?:a\s+)?comment/i,
  },
];

export interface AwayReplyExclusionHit {
  category: AwayReplyExclusionCategory;
}

/** The first rule the text trips, or null. Never returns the matched text: it may be state. */
export function findExcludedAction(text: string): AwayReplyExclusionHit | null {
  for (const rule of EXCLUSION_RULES) {
    if (rule.pattern.test(text)) return { category: rule.category };
  }
  return null;
}

/** Every rule the text trips, for the log. */
export function findExcludedActions(text: string): AwayReplyExclusionCategory[] {
  return EXCLUSION_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.category);
}

/**
 * Tools whose permission request is read-only whatever the input. Web tools are left out: a fetch
 * or a search sends text off the machine.
 */
const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);

const SHELL_METACHARACTERS = /[;&|<>`$\\\n\r(){}]/;
const READ_ONLY_PROGRAMS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "pwd",
  "rg",
  "grep",
  "find",
  "stat",
  "file",
  "du",
  "df",
  "uptime",
  "date",
  "which",
  "whoami",
  "tree",
]);
const FIND_WRITE_FLAGS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "ls-files",
  "blame",
]);
const READ_ONLY_GIT_BRANCH_FLAGS = new Set([
  "--list",
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--show-current",
]);

/**
 * A single command, no shell syntax, from a short allowlist of programs that only read. Anything
 * else, including anything this cannot parse, is not read-only.
 */
export function isReadOnlyShellCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || SHELL_METACHARACTERS.test(trimmed)) return false;
  const tokens = trimmed.split(/\s+/);
  const program = tokens[0];
  if (program === "git") return isReadOnlyGit(tokens.slice(1));
  if (!READ_ONLY_PROGRAMS.has(program)) return false;
  if (program === "find") return !tokens.some((token) => FIND_WRITE_FLAGS.has(token));
  return true;
}

function isReadOnlyGit(args: string[]): boolean {
  let rest = args;
  while (rest[0] === "-C" || rest[0] === "--no-pager") {
    rest = rest[0] === "-C" ? rest.slice(2) : rest.slice(1);
  }
  const [subcommand, ...flags] = rest;
  if (!subcommand) return false;
  if (subcommand === "branch") return flags.every((flag) => READ_ONLY_GIT_BRANCH_FLAGS.has(flag));
  if (subcommand === "remote")
    return flags.length === 0 || (flags.length === 1 && flags[0] === "-v");
  if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return false;
  return !flags.some((flag) => flag === "--output" || flag.startsWith("--output="));
}

/** The deterministic half of approving a tool permission; JEV must agree as well. */
export function isReadOnlyPermission(request: AgentPermissionRequest): boolean {
  if (request.kind !== "tool") return false;
  if (READ_ONLY_TOOLS.has(request.name)) return true;
  if (request.name !== "Bash") return false;
  const command = request.input?.["command"];
  return typeof command === "string" && isReadOnlyShellCommand(command);
}
