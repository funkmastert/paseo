import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import type { AgentPermissionRequest } from "../agent/agent-sdk-types.js";
import { findTokenKind, hasSecretName } from "../agent/snapshot-secret-filter.js";

/**
 * The away auto-reply's hard rules, in code (docs/jev.md, "Feature 14: away auto-reply"). They run
 * before any JEV call and again on the reply about to go out, and JEV cannot override them: a
 * thread that mentions any of these gets no auto-reply, whatever JEV answers.
 *
 * Broad on purpose, and it carries the safety, not JEV: JEV's published calibration error is
 * 0.13-0.25, so its answers are a second opinion. A false hit costs one reply Tyler writes himself
 * when he is back; a miss can merge a pull request or delete a tree on his behalf. Anything this
 * cannot read cleanly (a word spelled with lookalike letters from another script) counts as a hit.
 */

export type AwayReplyExclusionCategory =
  | "merge"
  | "force-push"
  | "git-history"
  | "destructive"
  | "credentials"
  | "release"
  | "payment"
  | "restart"
  | "outward-message"
  | "privilege"
  | "obfuscated";

/** Categories where only Tyler can act, so a hit may raise the agent's attention flag. */
export const TYLER_ONLY_CATEGORIES: ReadonlySet<AwayReplyExclusionCategory> = new Set([
  "credentials",
  "payment",
]);

interface ExclusionRule {
  category: AwayReplyExclusionCategory;
  pattern: RegExp;
}

/** Joined into one alternation per category; every entry is case-insensitive. */
const EXCLUSION_TABLE: ReadonlyArray<{ category: AwayReplyExclusionCategory; words: string[] }> = [
  {
    category: "merge",
    words: [
      String.raw`\b(?:un|auto-?|pre-?|re-?|squash-?)?merg(?:e|es|ed|ing|eable|er|ers)\b`,
      String.raw`\bland(?:s|ed|ing)?\b`,
      String.raw`\bfast[- ]?forward`,
      String.raw`--ff(?:-only)?\b`,
      String.raw`\bsquash`,
      String.raw`\bintegrat(?:e|es|ed|ing|ion)\b`,
      String.raw`\bfinali[sz]`,
      String.raw`\bcherry-?pick`,
      String.raw`\bready\s+(?:for|to)\s+(?:review|merge|land|ship)\b`,
      String.raw`\bmark(?:s|ed|ing)?\s+(?:\S+\s+){0,3}(?:as\s+)?ready\b`,
      String.raw`\bun-?draft`,
      String.raw`\bout\s+of\s+draft`,
      String.raw`\bapprov\w*\b[^\n.?!]{0,40}\b(?:prs?|pull\s+requests?|merges?|releases?|deploys?|reviews?)\b`,
      String.raw`\b(?:prs?|pull\s+requests?|reviews?)\b[^\n.?!]{0,40}\bapprov`,
      String.raw`\bgh\s+pr\b`,
      String.raw`\btea\s+pulls?\b`,
    ],
  },
  {
    category: "force-push",
    words: [
      String.raw`\bforce[- ]?push`,
      String.raw`(?:^|[\s'"=])--?force(?:-with-lease)?\b`,
      String.raw`(?:^|[\s'"])-[a-z]*f[a-z]*\b`,
      String.raw`(?:^|[\s'"])-D\b`,
    ],
  },
  {
    category: "git-history",
    words: [
      String.raw`\bgit\s+(?:\S+\s+)*?(?:reset|clean|restore|rebase|filter-branch|filter-repo|gc|prune|update-ref|reflog|rm|mv|revert|switch|checkout\s+(?:--|\.|-))`,
      String.raw`\bgit\s+(?:stash\s+(?:drop|clear|pop)|branch\s+-[dm]|tag\s+-d|worktree\s+(?:remove|prune))`,
      String.raw`\breset(?:s|ting)?\b`,
      String.raw`\brevert`,
      String.raw`\brebas`,
      String.raw`\bamend`,
      String.raw`\brestor(?:e|es|ed|ing)\s+\.`,
      String.raw`\bcheckout\s+--?\s*\.`,
      String.raw`\brewrit\w*\s+(?:the\s+|git\s+)?history`,
    ],
  },
  {
    category: "destructive",
    words: [
      String.raw`\bdelet`,
      String.raw`\bremov(?:e|es|ed|ing|al)\b`,
      String.raw`\bwip(?:e|es|ed|ing)\b`,
      String.raw`\bdrop(?:s|ped|ping)?\b`,
      String.raw`\bpurg`,
      String.raw`\bdestroy`,
      String.raw`\btruncat`,
      String.raw`\boverwrit`,
      String.raw`\bp?kill(?:s|ed|ing|all)?\b`,
      String.raw`\birreversib`,
      String.raw`\brm(?:dir)?\b`,
      String.raw`\bunlink\b`,
      String.raw`\bshred\b`,
      String.raw`\bmkfs`,
      String.raw`\bdd\s+if=`,
      String.raw`\bdiskutil\b`,
      String.raw`\bprun(?:e|es|ed|ing)\b`,
      String.raw`\beras(?:e|es|ed|ing|ure)\b`,
      String.raw`\bclear(?:s|ed|ing)?\s+(?:out|the|all|every|away|up|down|off)\b`,
      String.raw`\bnuk(?:e|es|ed|ing)\b`,
      String.raw`\bdiscard`,
      String.raw`\bget(?:ting)?\s+rid\s+of\b`,
      String.raw`\barchiv(?:e|es|ed|ing)\b`,
      String.raw`\btear(?:s|ing)?\s*down\b`,
      String.raw`\btorn\s+down\b`,
      String.raw`\buninstall`,
      String.raw`\breclaim`,
      String.raw`\bfree\s+up\b`,
      String.raw`\bformat(?:s|ted|ting)?\s+(?:the\s+|an?\s+)?(?:external\s+|usb\s+|whole\s+)?(?:drive|disk|volume|partition|ssd|hdd|card)`,
      String.raw`\bempty(?:ing)?\s+(?:the\s+|out\s+)?(?:trash|bin|recycle|caches?|queue|dirs?|folders?|director(?:y|ies)|db|database|tables?)`,
      String.raw`\btrash\b`,
      String.raw`\broll(?:s|ed|ing)?\s*back\b`,
      String.raw`\brollback`,
      String.raw`\bblow(?:s|ing|n)?\s+(?:\S+\s+)?away\b`,
      String.raw`\bclean(?:s|ed|ing)?\s*up\b`,
      String.raw`\bcleanup\b`,
      String.raw`\bclean(?:s|ed|ing)?\s+(?:the|all|out|every|old|stale|remote|branch|branches|worktrees?|repo|dirs?|build|caches?|disk)\b`,
      String.raw`\btid(?:y|ies|ied|ying)\b`,
      String.raw`\bmigrat(?:e|es|ed|ing|ion|ions)\b`,
      String.raw`\bdowngrad`,
      String.raw`\bdisabl(?:e|es|ed|ing)\b`,
      String.raw`\bterminat`,
      String.raw`\bcancel(?:s|led|ed|ling|ing)?\s+(?:the\s+|all\s+|other\s+|their\s+|its\s+)*(?:agents?|leaders?|workers?|runs?|turns?|jobs?|builds?|subscriptions?|orders?)\b`,
      String.raw`\bclos(?:e|es|ed|ing)\s+(?:the\s+|all\s+|those\s+|these\s+|stale\s+|old\s+|open\s+)*(?:issues?|prs?|pull\s+requests?|tickets?|threads?|workspaces?|agents?)\b`,
    ],
  },
  {
    category: "credentials",
    words: [
      String.raw`\bcredential`,
      String.raw`\bsecrets?\b`,
      String.raw`\bpasswords?\b`,
      String.raw`\bpasskeys?\b`,
      String.raw`\bapi[ _-]?keys?\b`,
      String.raw`\b(?:access|auth|bearer|oauth|refresh|github|gh|npm|pat|personal[ _-]access|api|jev|openrouter|session)[ _-]?tokens?\b`,
      String.raw`\boauth\b`,
      String.raw`\btokens?\s+(?:rotation|leak|expir)`,
      String.raw`\brotat(?:e|es|ed|ing|ion)\b`,
      String.raw`\brevok`,
      String.raw`\blog\s?(?:in|out)\b`,
      String.raw`\blog\s?ged\s+(?:in|out)\b`,
      String.raw`\bsign\s?(?:in|out)\b`,
      String.raw`\bre-?auth`,
      String.raw`\b(?:gh|glab|npm|claude|codex)\s+(?:auth|login|logout|token|adduser|setup-token)\b`,
      String.raw`\b2fa\b`,
      String.raw`\bmfa\b`,
      String.raw`\bssh[ _-]?keys?\b`,
      String.raw`\bprivate[ _-]?keys?\b`,
      String.raw`\bsigning\b`,
      String.raw`\bcertificates?\b`,
      String.raw`\bkeychain`,
      String.raw`\.env\b`,
      String.raw`\bhosts\.yml\b`,
      String.raw`\.config/gh\b`,
      String.raw`\bid_(?:rsa|dsa|ecdsa|ed25519)\b`,
      String.raw`\.(?:npmrc|netrc|pypirc|pgpass)\b`,
      String.raw`\bauth\.json\b`,
      String.raw`(?:^|[\s/~])\.(?:ssh|aws|gnupg|kube|docker)\b`,
      String.raw`\.(?:pem|p12|pfx)\b`,
      String.raw`daemon-keypair`,
    ],
  },
  {
    category: "release",
    words: [
      String.raw`\bdeploy`,
      String.raw`\breleas(?:e|es|ed|ing)\b`,
      String.raw`\bpublish`,
      String.raw`\bgit\s+tag\b`,
      String.raw`\btag(?:s|ged|ging)?\s+(?:a\s+|the\s+)?(?:v?\d|release|version|build)`,
      String.raw`--tags\b`,
      String.raw`\bship(?:s|ped|ping)?\b`,
      String.raw`\bgo(?:es|ing)?\s+live\b`,
      String.raw`\broll(?:ing)?\s*out\b`,
      String.raw`\b(?:to|in|on|into)\s+prod(?:uction)?\b`,
      String.raw`\bbeta\b`,
      String.raw`\bcut\s+(?:a|an|the)\s+(?:new\s+)?(?:beta|release|build|version|tag|rc|stable)\b`,
      String.raw`\bpromot(?:e|es|ed|ing|ion)\b`,
      String.raw`\btestflight\b`,
      String.raw`\b(?:app|play)\s*store\b`,
      String.raw`\bplay\s+console\b`,
      String.raw`\beas\s+(?:submit|build|update)\b`,
      String.raw`\bsubmit(?:s|ted|ting)?\b`,
      String.raw`\bupload(?:s|ed|ing)?\b`,
      String.raw`\bnpm\s+(?:version|publish|deprecate|unpublish|dist-tag)\b`,
      String.raw`\bversion\s+bump`,
      String.raw`\bbump(?:s|ed|ing)?\s+(?:the\s+)?version`,
      String.raw`\bhotfix`,
    ],
  },
  {
    category: "payment",
    words: [
      String.raw`\bpay(?:s|ing|ment|ments)?\b`,
      String.raw`\bpaid\b`,
      String.raw`\bpurchas`,
      String.raw`\bbuy(?:s|ing)?\b`,
      String.raw`\bbilling\b`,
      String.raw`\binvoic`,
      String.raw`\bcredit\s+card`,
      String.raw`\brefund`,
      String.raw`\bcredits?\b`,
      String.raw`\btop(?:ping)?[- ]?up\b`,
      String.raw`\b(?:spend(?:ing)?|usage|budget)\s+(?:cap|limit|ceiling)s?\b`,
      String.raw`\braise\b[^\n.?!]{0,30}\b(?:cap|limit|budget|quota|ceiling)`,
      String.raw`\bextra\s+usage\b`,
      String.raw`\bsubscri(?:be|bed|bing|ption)`,
      String.raw`\bupgrad(?:e|es|ed|ing)\b`,
      String.raw`\boverage\b`,
      String.raw`\bcharg(?:e|es|ed|ing)\b`,
      String.raw`\bstripe\b`,
      String.raw`\$\s?\d`,
    ],
  },
  {
    category: "restart",
    words: [
      String.raw`\bre-?launch`,
      String.raw`\brestart`,
      String.raw`\breboot`,
      String.raw`\bbounc(?:e|es|ed|ing)\b`,
      String.raw`\bcycl(?:e|es|ed|ing)\b`,
      String.raw`\bkickstart`,
      String.raw`\brespawn`,
      String.raw`\breload`,
      String.raw`\bshut\s*down\b`,
      String.raw`\bstop(?:s|ped|ping)?\s+(?:the\s+)?(?:\S+\s+)?(?:daemon|server|service|app|launchd)\b`,
      String.raw`\blaunchctl\b`,
      String.raw`\bsystemctl\b`,
      String.raw`\bplugins?\s+(?:reload|install|uninstall|remove|enable|disable|update)\b`,
      String.raw`\b6767\b`,
      String.raw`\b(?:paseo|bozeo)\s+(?:daemon\s+)?(?:reload|stop|start|restart)\b`,
    ],
  },
  {
    category: "outward-message",
    words: [
      String.raw`\b(?:send|post|email|e-mail|dm|message|ping|notify|tweet|reply\s+to|respond\s+to|comment\s+(?:on|in))\b[^\n.?!]{0,60}\b(?:slack|email|them|him|her|team|reviewers?|channel|customers?|users?|colleagues?|people|everyone|issue|pr|pull\s+request|thread|discord|twitter|linkedin|andrew)\b`,
      String.raw`\bslack\b`,
      String.raw`\bdiscord\b`,
      String.raw`\be-?mail`,
      String.raw`\btweet`,
      String.raw`\blinkedin\b`,
      String.raw`\bwebhook`,
      String.raw`\bpost(?:s|ed|ing)?\b`,
      String.raw`\bpush(?:es|ed|ing)?\b`,
      String.raw`\bsync(?:s|ed|ing)?\b[^\n.?!]{0,40}\b(?:origin|remote|upstream|fork|github|gitea|wondergit|branch)\b`,
      String.raw`\b(?:open|create|file|raise)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:prs?|pull\s+requests?|issues?|tickets?|bugs?|reports?)\b`,
      String.raw`\bgh\s+(?:pr|issue|release|api|repo|gist)\b`,
      String.raw`\btea\s+\w+`,
      String.raw`\btell\s+(?!me\b|you\b|yourself\b)\w+`,
      String.raw`\blet\s+(?!me\b)(?:\S+\s+){1,4}know\b`,
      String.raw`\b(?:linear|jira|notion|confluence|asana|trello)\b`,
      String.raw`\btickets?\b`,
      String.raw`\bupstream\b`,
      String.raw`(?:^|\s)#[a-z][\w-]*`,
      String.raw`\brequest(?:s|ed|ing)?\s+(?:\S+\s+){0,3}(?:review|approval)`,
      String.raw`\bshare\s+(?:it|this|that|the)\b`,
    ],
  },
  {
    category: "privilege",
    words: [
      String.raw`\bsudo\b`,
      String.raw`\bchmod\b`,
      String.raw`\bchown\b`,
      String.raw`\.paseo\b`,
      String.raw`\bbypass`,
      String.raw`\bdangerously`,
      String.raw`\bpermission\s+mode`,
      String.raw`\bset_agent_mode\b`,
    ],
  },
];

/**
 * Environment names of credentials, which the lowercase rules miss: `\b` never matches between
 * `_` and a letter. Case-sensitive, so a word like "key" in prose does not count.
 */
const SECRET_ENV_NAME =
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASS|PAT|CREDENTIALS?)\b/;

const EXCLUSION_RULES: readonly ExclusionRule[] = [
  ...EXCLUSION_TABLE.map(({ category, words }) => ({
    category,
    pattern: new RegExp(words.join("|"), "im"),
  })),
  { category: "credentials", pattern: SECRET_ENV_NAME },
];

/**
 * Letters from other scripts that look like Latin ones. Folded before scanning, so `mеrge` (a
 * Cyrillic е) reads as `merge`. A lookalike missing here still trips `obfuscated`.
 */
/** Each lookalike, then the Latin letter it imitates. */
const CONFUSABLE_PAIRS =
  "аa вb еe ёe кk мm нh оo рp сc тt уy хx ѕs іi їi јj ԁd һh ӏl ԛq ԝw " +
  "АA ВB ЕE КK МM НH ОO РP СC ТT УY ХX ЅS ІI ЈJ " +
  "αa εe ιi κk νv οo ρp τt υu χx ΑA ΒB ΕE ΖZ ΗH ΙI ΚK ΜM ΝN ΟO ΡP ΤT ΥY ΧX " +
  "ɡg ɑa ոn սu ցg օo";
const CONFUSABLES: ReadonlyMap<string, string> = new Map(
  CONFUSABLE_PAIRS.split(" ").map((pair) => [pair[0], pair[1]] as const),
);

/** NFKC (fullwidth, ligatures), no format characters (zero-width, soft hyphen), plain quotes. */
function normalizeUnicode(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-");
}

/** The text the rules read: normalized, lookalikes folded to Latin. */
export function normalizeForScan(text: string): string {
  return normalizeUnicode(text).replace(/\P{ASCII}/gu, (char) => CONFUSABLES.get(char) ?? char);
}

/** A word mixing Latin letters with letters of another script, which no honest word does. */
function hasMixedScriptWord(text: string): boolean {
  for (const [word] of text.matchAll(/\p{L}+/gu)) {
    if (/[A-Za-z]/.test(word) && /[^\p{Script=Latin}]/u.test(word)) return true;
  }
  return false;
}

export interface AwayReplyExclusionHit {
  category: AwayReplyExclusionCategory;
}

/** Every category the text trips. Never returns the matched text: it may be state. */
export function findExcludedActions(text: string): AwayReplyExclusionCategory[] {
  const unicode = normalizeUnicode(text);
  const folded = normalizeForScan(text);
  // `PASEO_JEV_API_KEY` reads as words once `_` is a space.
  const spaced = folded.replace(/_/g, " ");
  const hits = new Set<AwayReplyExclusionCategory>();
  if (hasMixedScriptWord(unicode)) hits.add("obfuscated");
  for (const rule of EXCLUSION_RULES) {
    if (rule.pattern.test(folded) || rule.pattern.test(spaced)) hits.add(rule.category);
  }
  return [...hits];
}

/** The first rule the text trips, or null. */
export function findExcludedAction(text: string): AwayReplyExclusionHit | null {
  const [category] = findExcludedActions(text);
  return category ? { category } : null;
}

/**
 * Company code (docs/jev.md, D7, and the standing rule against changing company repos): the
 * feature does not act on a thread or a leader that names any of these, whatever
 * `agents.jev.exclude*` says. Not configurable on purpose: relaxing JEV's egress lists must never
 * let this feature act as Tyler in a company repo.
 */
const COMPANY_MARKERS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "wonderly", pattern: /wonderly/i },
  { name: "wondergit", pattern: /wondergit/i },
  { name: "backend-net", pattern: /backend[-_ ]?net/i },
  { name: "bn-worktrees", pattern: /bn[-_ ]?worktrees/i },
  { name: "ts-monorepo", pattern: /ts[-_ ]?monorepo/i },
  { name: "motion-net", pattern: /motion[-_ ]?net/i },
  { name: "wonderpod", pattern: /wonder[-_ ]?pod/i },
  { name: "mobile-worktrees", pattern: /mobile[-_ ]?worktrees/i },
  { name: "1rlfnz6g", pattern: /1rlfnz6g/i },
];

/** The first company marker in `text`, by name, or null. */
export function findCompanyMarker(text: string): string | null {
  const folded = normalizeForScan(text);
  return COMPANY_MARKERS.find(({ pattern }) => pattern.test(folded))?.name ?? null;
}

/**
 * Tools whose permission request may be approved: they only read, and each names the paths it
 * reads. Web tools are left out (a fetch or a search sends text off the machine), and so is Bash:
 * no allowlist over a shell line is sound enough to answer as Tyler. Quoting (`-de''lete`),
 * wrappers and flags like `rg --pre`, `tree -o` or `find -fprint` turn a read into a write or a
 * program run.
 */
const READ_ONLY_TOOLS: Readonly<
  Record<
    string,
    { paths: string[]; patterns?: string[]; allowed: ReadonlySet<string>; fileOnly?: boolean }
  >
> = {
  Read: {
    paths: ["file_path"],
    allowed: new Set(["file_path", "offset", "limit", "pages"]),
    fileOnly: true,
  },
  NotebookRead: {
    paths: ["notebook_path"],
    allowed: new Set(["notebook_path", "cell_id"]),
    fileOnly: true,
  },
  LS: { paths: ["path"], allowed: new Set(["path", "ignore"]) },
  Glob: { paths: ["path"], patterns: ["pattern"], allowed: new Set(["pattern", "path"]) },
  // Grep reads file contents, so only one named file: a directory can hold a `.env`.
  Grep: {
    paths: ["path"],
    allowed: new Set([
      "pattern",
      "path",
      "output_mode",
      "-i",
      "-n",
      "-A",
      "-B",
      "-C",
      "head_limit",
      "multiline",
    ]),
    fileOnly: true,
  },
};

/**
 * Paths that are secrets wherever they sit, on top of the work-snapshot secret-name rule
 * (`hasSecretName`): credential directories, keys, keychains, the daemon's own keypair, and the
 * Claude account directories.
 */
const SECRET_PATH =
  /(?:^|[\\/])(?:\.ssh|\.gnupg|\.aws|\.kube|\.docker|\.azure|\.gcloud|\.config[\\/](?:gh|gcloud|op|hub|git-credential))(?:[\\/]|$)|(?:^|[\\/])\.claude[^\\/]*(?:[\\/]|$)|(?:^|[\\/])[._]?netrc$|\.(?:pem|p12|pfx|key|keystore|jks|mobileprovision)$|(?:^|[\\/])\.env|keychain|daemon-keypair\.json$|(?:^|[\\/])\.paseo(?:[\\/]|$)/i;

export interface ReadScope {
  /** The leader's working directory. Reads are approved only inside it. */
  cwd: string;
  home: string | null;
}

/** `target`'s real path; for a path that does not exist yet, its nearest real ancestor's. */
function realPath(target: string): string {
  const rest: string[] = [];
  let current = target;
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...rest.toReversed());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

function isFile(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * The path inside the leader's cwd a tool input names, or null when it is outside it, under a
 * dot-directory or a dotfile, or looks like a secret. Symlinks are resolved first, so a link in
 * the tree cannot point the read at `~/.ssh`.
 */
function confinedPath(raw: unknown, scope: ReadScope): string | null {
  if (raw === undefined) return path.resolve(scope.cwd);
  if (typeof raw !== "string" || raw.trim() === "" || raw.includes("\0")) return null;
  let expanded = raw;
  if (raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")) {
    if (!scope.home) return null;
    expanded = path.join(scope.home, raw.slice(1));
  } else if (raw.startsWith("~")) {
    return null;
  }
  const absolute = path.resolve(scope.cwd, expanded);
  const real = realPath(absolute);
  const root = realPath(path.resolve(scope.cwd));
  const relative = path.relative(root, real);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const segments = relative.split(/[\\/]/).filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment.startsWith("."))) return null;
  if (SECRET_PATH.test(real) || SECRET_PATH.test(absolute)) return null;
  if (relative && hasSecretName(segments.join("/"))) return null;
  if (findTokenKind(raw) !== null) return null;
  return real;
}

/** A glob relative to the path it runs in: no `..`, no absolute path, no dot segment, no `~`. */
function isConfinedPattern(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.trim() === "" || raw.includes("\0")) return false;
  if (raw.startsWith("/") || raw.startsWith("\\") || raw.startsWith("~") || /^[a-z]:/i.test(raw)) {
    return false;
  }
  const segments = raw.split(/[\\/]/);
  if (segments.some((segment) => segment === ".." || segment.startsWith("."))) return false;
  return !hasSecretName(raw) && !SECRET_PATH.test(raw) && findTokenKind(raw) === null;
}

/**
 * The deterministic half of approving a tool permission; JEV must agree as well. Only the
 * read-only tools, only inside the leader's cwd, never a secret, never Bash.
 */
export function isReadOnlyPermission(request: AgentPermissionRequest, scope: ReadScope): boolean {
  if (request.kind !== "tool") return false;
  const tool = READ_ONLY_TOOLS[request.name];
  if (!tool) return false;
  const input = request.input ?? {};
  if (Object.keys(input).some((key) => !tool.allowed.has(key))) return false;
  for (const field of tool.paths) {
    const value = input[field];
    if (tool.fileOnly && value === undefined) return false;
    const confined = confinedPath(value, scope);
    if (!confined) return false;
    if (tool.fileOnly && !isFile(confined)) return false;
  }
  return (tool.patterns ?? []).every((field) => isConfinedPattern(input[field]));
}
