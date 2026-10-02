import type { JevAnswer, JevChoiceAnswer, JevWireRequest } from "./contract.js";

/**
 * Redaction of every JEV request body (docs/jev.md, "Redaction"). The walk redacts each string
 * leaf and object key of `state` and `questions` where newlines are still real; an exact-value
 * pass then runs over the serialized JSON. Every rule matches on the original text and the
 * matches are merged before anything is replaced, so no rule sees another's output and each
 * `[redacted:<kind>]` counts once.
 *
 * Every pattern is linear: bounded quantifiers, character classes that cannot overlap, and
 * manual scans where a regex would backtrack. The body can be 64 KB of hostile text.
 */

export interface JevSecretValue {
  /** Shown in `[redacted:<kind>]`. Anything but a short lowercase slug is shown as `exact`. */
  kind: string;
  value: string;
}

/** A secret-shaped name, matched against the whole name and against its last segment. */
export const SECRET_NAME_RE =
  /^(?:secret|token|passw(?:or)?d|pwd|pass|api[_-]?key|key|auth|credentials?|private[_-]?key|pat|dsn|salt|signing|private)$/i;
/** The same words closing a run-together segment: `AUTHTOKEN`, `PGPASSWORD`, `SSHPASS`. */
const SECRET_SUFFIX_RE =
  /(?:secret|token|passw(?:or)?d|passphrase|pwd|pass|key|auth|credentials?)$/i;

const MIN_SECRET_LENGTH = 8;
/** A PIN or a one-time code is short: `ADMIN_PIN=482913`. */
const SHORT_SECRET_NAME_RE = /^(?:pin|passcode|otp)$/i;
const MIN_SHORT_SECRET_LENGTH = 4;
/**
 * Short values that are not secrets, for the rules that take values from 4 characters: a
 * placeholder, a boolean or null, a variable, a mask.
 */
const PLACEHOLDER_VALUE_RE =
  /^(?:true|false|null|none|nil|undefined|yes|no|on|off|empty|\*+|x+|\.{3,}|\$\{?[A-Za-z_]\w*\}?|<[^>]*>|\[redacted:[a-z-]+\])$/i;
/** Names whose value is a `user:password` pair: `SMTP_LOGIN=ops:Hunter22pw`. */
const PAIR_NAME_RE = /^(?:login|creds?|userpass|basic(?:auth)?)$/i;
/**
 * A key or a token as an assignment's whole value: a base64 run of 16 or more that ends the value.
 * Sticky at the value's start and bounded, so a name in every few characters stays linear.
 */
const BASE64_VALUE_RE = /\\?["']?([A-Za-z0-9+/]{16,4096}={0,2})(?![\w+/=.:@-])/y;
/** A password after an email address and a colon: `ops@example.com:Hunter22pw`. */
const PAIR_PASSWORD_RE = /:([^\s"'`,;&|@:/]{4,256})/y;
/** A JSON `"value": "…"`, as Terraform state keeps outputs and attributes. */
const JSON_VALUE_RE = /"value"[ \t\r\n]{0,16}:[ \t\r\n]{0,16}"((?:[^"\\\r\n]|\\.){1,4096})"/g;
/** `"sensitive": true` in the same object as a `"value"`, before or after it. */
const SENSITIVE_RE = /"sensitive"[ \t\r\n]{0,16}:[ \t\r\n]{0,16}true/;
/** The key whose object holds a `"value"`: `"admin_token": {"value": …`. */
const VALUE_PARENT_RE =
  /"([A-Za-z_][\w.-]{0,63})"[ \t\r\n]{0,16}:[ \t\r\n]{0,16}\{[ \t\r\n]{0,16}$/;
const OBJECT_CONTEXT_CHARS = 256;
const SAFE_KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;
const LAST_CAMEL_WORD_RE = /(?:[A-Z][a-z0-9]+|[A-Z]+|[a-z0-9]+)$/;

/**
 * The doc's secret-name rule: the name, its last `_`/`-`/`.` segment or how that segment ends
 * (`NGROK_AUTHTOKEN`, `PGPASSWORD`), or that segment's last camelCase word (`apiKey`,
 * `_authToken`), or a database URL (`DATABASE_URL`, `sentryDsnUrl`). Plurals and qualifiers
 * after the word are not secrets: `max_tokens`, `key-file`, `password-stdin`.
 */
export function isSecretName(name: string): boolean {
  if (SECRET_NAME_RE.test(name)) return true;
  const lastSegment = name.split(/[_.-]/).findLast((segment) => segment.length > 0) ?? "";
  if (SECRET_NAME_RE.test(lastSegment) || SECRET_SUFFIX_RE.test(lastSegment)) return true;
  const lastWord = LAST_CAMEL_WORD_RE.exec(lastSegment)?.[0] ?? "";
  if (SECRET_NAME_RE.test(lastWord)) return true;
  // A service-account key's id names the key: `private_key_id`.
  if (/private[_-]?key[_-]?id$/i.test(name)) return true;
  return /url$/i.test(name) && /database|dsn/i.test(name);
}

/** Kept off the instance, so logging a set can never print a secret. */
const EXACT_FORMS = new WeakMap<JevExactSecretSet, readonly JevSecretValue[]>();

/** The daemon's own secrets, matched exactly: raw, JSON-escaped once and twice, longest first. */
export class JevExactSecretSet {
  readonly size: number;

  constructor(values: readonly JevSecretValue[]) {
    const kindByValue = new Map<string, string>();
    for (const { kind, value } of values) {
      if (value.length < MIN_SECRET_LENGTH || kindByValue.has(value)) continue;
      kindByValue.set(value, SAFE_KIND_RE.test(kind) ? kind : "exact");
    }
    const kindByForm = new Map<string, string>();
    for (const [value, kind] of kindByValue) {
      for (const form of jsonForms(value)) {
        if (!kindByForm.has(form)) kindByForm.set(form, kind);
      }
    }
    const forms = [...kindByForm].map(([value, kind]) => ({ kind, value }));
    forms.sort((a, b) => b.value.length - a.value.length);
    this.size = kindByValue.size;
    EXACT_FORMS.set(this, forms);
  }
}

export interface JevKeyMapEntry {
  id: string;
  criteria: Record<string, string>;
}

/** Sent question id to the caller's id and changed choice keys, only where redaction changed one. */
export interface JevKeyMap {
  [sentQuestionId: string]: JevKeyMapEntry;
}

export interface JevRedactionResult {
  /** Parsed from `serialized`, so the two are the same bytes. */
  request: JevWireRequest;
  /** Exactly what will be sent. */
  serialized: string;
  /** `[redacted:<kind>]` and `[email]` replacements. The home prefix becoming `~` is not counted. */
  count: number;
  keyMap: JevKeyMap;
}

export type JevRedactionFailure = "key-collision" | "unparseable" | "structure-changed";

/** Carries no text from the request: the service answers `failed: redaction` and sends nothing. */
export class JevRedactionError extends Error {
  constructor(readonly failure: JevRedactionFailure) {
    super(`jev redaction failed: ${failure}`);
    this.name = "JevRedactionError";
  }
}

interface TextRange {
  start: number;
  end: number;
}

interface SecretSpan extends TextRange {
  kind: string;
}

/**
 * A URL's userinfo, up to the `@`. A span that starts inside it stops at the `@`, so the host
 * survives for the D7 text scan (`token:ghs_…@github.com/org/repo`).
 */
interface UserinfoGuard extends TextRange {}

interface LeafFindings {
  secrets: SecretSpan[];
  guards: UserinfoGuard[];
  emails: TextRange[];
  homes: TextRange[];
}

interface WalkContext {
  secrets: JevExactSecretSet;
  home: RegExp | null;
  count: number;
}

const PEM_BEGIN_RE = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/gi;
const PEM_END_RE = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/gi;
/** Longest body searched above an END whose BEGIN was clipped away. A 4096-bit RSA key is ~3.2 KB. */
const PEM_MAX_BODY = 16_384;
const LINE_BREAK_RE = /\r?\n|\\r?\\n/g;
const PEM_BODY_LINE_RE = /^[ \t]*[A-Za-z0-9+/=]*[ \t]*$/;

const AUTH_HEADER_RE =
  /(?<![A-Za-z0-9_-])(?:proxy-)?authorization\\?["']?[ \t]{0,16}[:=][ \t]{0,16}\\?["']?([^\r\n"'\\]{8,})/gi;
const BEARER_RE = /(?<![A-Za-z0-9_-])bearer[ \t]{1,16}([A-Za-z0-9._~+/-]{16,}=*)/gi;
const TOKEN_RE =
  /(?<![A-Za-z0-9_-])(?:(?:sk-ant-|sk-or-|sk-|sk_live_|rk_live_|gh[pousr]_|github_pat_|glpat-|xox[abeprs]-|xapp-|tskey-|figd_|glsa_)[A-Za-z0-9_-]{16,}|(?:sk_test_|rk_test_|lin_api_|ntn_|dop_v1_|whsec_)[a-z0-9]{16,}|secret_[a-z0-9]{40,}|sg\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|1\/\/0[A-Za-z0-9_-]{16,}|npm_[a-z0-9]{36,}|ya29\.[A-Za-z0-9_.-]{16,}|(?:akia|asia)[a-z0-9]{16}(?![a-z0-9])|aiza[a-z0-9_-]{30,})/gi;
/** Slack and Discord incoming webhooks: the host stays, the path that is the credential goes. */
const WEBHOOK_RE =
  /(?:hooks\.slack\.com\/(?:services|workflows|triggers)|discord(?:app)?\.com\/api\/webhooks)\/([A-Za-z0-9_/-]{16,})/gi;
const JWT_RE = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/gi;
const USERINFO_RE =
  /(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\/([^\s/?#@:"'<>\\]{0,256}):([^\s/?#@"'<>\\]{1,256})@/gi;
/** A name and its separator; the value is read by `assignedValue`. */
const ASSIGNMENT_NAME_RE =
  /(?<![\w.$-])\\?["']?([A-Za-z_][\w.-]{0,63})\\?["']?[ \t]{0,16}([:=])[ \t]{0,16}/g;
/** Names whose values can be phrases with spaces; tokens and keys never have them. */
const PASSPHRASE_NAME_RE = /(?:passw(?:or)?d|passphrase|pass|pwd|secret)$/i;
/** Where a YAML key starts a line, optionally as a list item. */
const LINE_START_RE = /(?<=(?:^|[\r\n])[ \t]{0,32}(?:-[ \t]{1,8})?)/y;
/** A YAML scalar: its words to the end of the line, stopping at a ` #` comment. */
const LINE_VALUE_RE = /[^\s"'`,;&|]+(?:[ \t]+(?!#)[^\s"'`,;&|]+)*/y;
const QUOTE_START_RE = /^["'\\]/;
/** `--token X`, `--password=X`, `"--token","X"`: the name is judged by `isSecretName`. */
const FLAG_RE =
  /(?<![\w-])--?([A-Za-z][\w-]{0,63})(?:=|[ \t]{1,16}|\\?["'][ \t]{0,16},[ \t]{0,16})/g;
/** A bare word and the blanks after it: `aws configure set aws_secret_access_key X`. */
const ARGUMENT_NAME_RE = /(?<![\w.$-])([A-Za-z_][\w.-]{0,63})[ \t]{1,16}/g;
/** Secret words that are prose on their own ("the token expired"), not an argument's name. */
const PROSE_SECRET_WORD_RE = /^(?:secret|token|pass|pwd|key|auth|credentials?|pat|dsn)$/i;
/** Another option where a value would start, possibly quoted: `--token --verbose`. */
const OPTION_AHEAD_RE = /\\?["']?-/y;
/** Not a secret argument: `$VAR`, a URL, or a path (base64 has no `.`, `~`, `-`, `_` or `\`). */
const NOT_SECRET_ARGUMENT_RE =
  /^(?:\$\{?[A-Za-z_]\w*\}?$|[a-z][a-z0-9+.-]*:\/\/|(?:~|\.{1,2}|[a-z]:)[\\/]|\\|\/(?=.*[^a-z0-9+/=]))/i;
/**
 * Commands whose `-p` is a password. The mysql family takes it attached (`-pX`), since `-p X`
 * prompts and names a database; the others take it either way.
 */
const PASSWORD_COMMAND_RE =
  /(?<![\w./-])(?:(mysql(?:dump|admin|import|show|check|pump)?|mariadb(?:-dump|-admin)?)|sshpass|mongo(?:sh|dump|restore|import|export)?|(?:docker|podman|nerdctl|buildah|skopeo|oras)[ \t]{1,16}login)(?![\w.-])/g;
/**
 * Commands whose option takes a `user:password` pair: curl's `-u`/`--user`/`--proxy-user` (also
 * inside a cluster, `-sSu`), HTTPie's and xh's `-a`/`--auth`. The password half goes; a value with
 * no password (`-u sk_live_…:`) is a token as the user, and goes whole.
 */
const PAIR_COMMAND_RULES: readonly CommandCredentialRule[] = [
  {
    commands: /(?<![\w./-])curl(?![\w.-])/g,
    flag: /(?<!\S)(?:--(?:proxy-)?user(?![\w-])|-[A-Za-z]{0,16}?[uU])/g,
    attached: true,
    pair: true,
  },
  {
    commands: /(?<![\w./-])(?:https?|xh|xhs)(?![\w.:/-])/g,
    flag: /(?<!\S)(?:--auth(?![\w-])|-[A-Za-z]{0,16}?a)/g,
    attached: true,
    pair: true,
  },
  {
    commands: /(?<![\w./-])redis-cli(?![\w.-])/g,
    flag: /(?<!\S)-a(?![\w-])/g,
    attached: false,
    pair: false,
  },
  {
    commands:
      /(?<![\w./-])ldap(?:search|modify|add|delete|passwd|compare|whoami|exop|modrdn)(?![\w.-])/g,
    flag: /(?<!\S)-[wy](?![\w-])/g,
    attached: false,
    pair: false,
  },
];

interface CommandCredentialRule {
  commands: RegExp;
  flag: RegExp;
  /** The value may follow the option with no gap: `-uadmin:pw`. */
  attached: boolean;
  /** The value is `user:password`. */
  pair: boolean;
}

/** OpenSSL's `-passin pass:X`, `-passout pass:X`, `-pass pass:X`. */
const OPENSSL_PASS_RE = /(?<![\w-])-pass(?:in|out)?[ \t]{1,16}\\?["']?pass:([^\s"'\\]{1,256})/g;
/** `-H 'X-Api-Key: v'`, `--header "Cookie: …"`: a credential header's value, at any length. */
const HEADER_FLAG_RE =
  /(?<![\w-])(?:-H|--header)(?:=|[ \t]{1,16})\\?["']?([A-Za-z][A-Za-z0-9-]{0,63})[ \t]{0,16}:[ \t]{0,16}([^\r\n"'\\]{1,4096})/g;
const CREDENTIAL_HEADER_RE = /^(?:(?:proxy-)?authorization|cookie|set-cookie)$/i;
/** PHP's `define('DB_PASSWORD', '…')`: WordPress keeps its credentials and salts this way. */
const PHP_DEFINE_RE =
  /define[ \t]{0,16}\([ \t]{0,16}\\?["']([A-Za-z_]\w{0,63})\\?["'][ \t]{0,16},[ \t]{0,16}\\?(["'])((?:(?!\\?\2)[^\r\n]){1,4096})\\?\2/g;
/** A crypt-style password hash: `.htpasswd`'s `$apr1$…`, bcrypt's `$2y$…`, sha512-crypt's `$6$…`. */
const PASSWORD_HASH_RE =
  /(?<![\w$])\$(?:apr1|2[abxy]?|1|5|6|y|argon2(?:id|i|d))\$[^\s:"'`,;]{8,256}/g;

/** Where a command ends: a newline without a `\` continuation, `;`, `|` or `&`. */
const COMMAND_END_RE = /(?<!\\)\r?\n|[;|&]/g;
const SHORT_PASSWORD_FLAG_RE = /(?<!\S)-p/g;
const PASSWORD_FLAG_GAP_RE = /=|[ \t]{1,16}/y;
const GENERIC_ASSIGNMENT_RE =
  /(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|auth|credential|private[_-]?key)\\?["']?\s{0,32}[:=]\s{0,32}\\?["']?([^\s"',]{8,})/gi;
const ENTROPY_RE = /(?:[=:]|bearer[ \t]{1,16})[ \t]{0,16}\\?["']?([A-Za-z0-9+/_-]{32,})={0,2}/gi;
const MIN_ENTROPY_BITS = 4;
/**
 * A run of base64 or hex characters standing alone, judged by `isSecretRun`. A run after a `.`
 * is a host's or file's tail (`hooks.slack.com/services/…`), which other rules own.
 */
const BARE_RUN_RE = /(?<![A-Za-z0-9+/_.-]|sha\d{1,3}:)[A-Za-z0-9+/_-]{40,}={0,2}/gi;
const MIN_BARE_RUN_LENGTH = 40;
/** A content digest (`sha512-…` in a lockfile, `sha256:…` in an image), not a secret. */
const DIGEST_RE = /^sha\d{1,3}-/i;
const HEX_RE = /^[0-9a-f]+$/i;
const MIN_HEX_SECRET_LENGTH = 64;
/**
 * Random data changes between lower case, upper case, digits and symbols on about 65% of
 * adjacent characters and measures 4.6 bits or more over 40 characters. camelCase identifiers
 * and paths reach 4.5 bits but change class on under 40%.
 */
const MIN_BARE_ENTROPY_BITS = 4.5;
const MIN_CLASS_CHANGE_RATIO = 0.45;
/** Base64 that decodes to this share of printable text is encoded text, which may hide a secret. */
const MIN_PRINTABLE_RATIO = 0.95;
const MIN_DECODED_BYTES = 24;
const EMAIL_RE =
  /(?<![\w.+%-])[A-Za-z0-9][\w.+%-]{0,63}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}(?![A-Za-z0-9-])/g;

/** Tried in order at the first character after an assignment's separator. */
const VALUE_RES = [
  /\\"([^"\\\r\n]{0,4096})/y,
  /"((?:[^"\\\r\n]|\\.){0,4096})/y,
  /'([^'\r\n]{0,4096})/y,
  /([^\s"'`,;&|]*)/y,
];

export function redactJevRequest(
  request: JevWireRequest,
  options: { secrets: JevExactSecretSet; homeDir: string },
): JevRedactionResult {
  const ctx: WalkContext = {
    secrets: options.secrets,
    home: homePattern(options.homeDir),
    count: 0,
  };
  const state = redactValue(toPlainJson(request.state), ctx);
  const walked = redactQuestions(toPlainJson(request.questions), ctx);
  const sentState = exactPassOverJson(JSON.stringify(state), ctx);
  const sentQuestions = exactPassOverJson(JSON.stringify(walked.questions), ctx);
  if (questionShape(sentQuestions) !== questionShape(walked.questions)) {
    throw new JevRedactionError("structure-changed");
  }
  const serialized = JSON.stringify({
    model: request.model,
    state: sentState,
    questions: sentQuestions,
  });
  return { request: JSON.parse(serialized), serialized, count: ctx.count, keyMap: walked.keyMap };
}

/** Maps answers keyed by what was sent back to the caller's question ids and choice keys. */
export function restoreAnswerKeys(
  answers: Record<string, JevAnswer>,
  keyMap: JevKeyMap,
): Record<string, JevAnswer> {
  const restored = Object.entries(answers).map(([sentId, answer]): [string, JevAnswer] => {
    if (!Object.hasOwn(keyMap, sentId)) return [sentId, answer];
    const entry = keyMap[sentId];
    return [entry.id, answer.type === "choice" ? restoreChoice(answer, entry.criteria) : answer];
  });
  return Object.fromEntries(restored);
}

function restoreChoice(answer: JevChoiceAnswer, criteria: Record<string, string>): JevChoiceAnswer {
  const original = (key: string) => (Object.hasOwn(criteria, key) ? criteria[key] : key);
  const probabilities = Object.entries(answer.probabilities).map(([key, p]) => [original(key), p]);
  return {
    ...answer,
    choice: original(answer.choice),
    probabilities: Object.fromEntries(probabilities),
  };
}

/** What `JSON.stringify` would send: `toJSON` applied, `undefined` and functions dropped. */
function toPlainJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactValue(value: unknown, ctx: WalkContext): unknown {
  if (typeof value === "string") return redactText(value, ctx);
  if (Array.isArray(value)) {
    const items = isStringArray(value) ? redactArgvContext(value, ctx) : value;
    return items.map((item) => redactValue(item, ctx));
  }
  if (isRecord(value))
    return redactRecord(value, ctx, (key, item) => redactField(key, item, ctx)).record;
  return value;
}

function isStringArray(value: unknown[]): value is string[] {
  return value.length > 1 && value.every((item) => typeof item === "string");
}

/**
 * An argv held as an array keeps a flag and its value in separate strings, where no text rule sees
 * both (`["ngrok", "--authtoken", X]`, `["mysql", "-pX"]`). The rules that read a value from its
 * context run over the elements joined by spaces, and each match is cut out of the element it
 * falls in; every element then goes through the text rules as usual.
 */
function redactArgvContext(items: string[], ctx: WalkContext): string[] {
  const joined = items.join(" ");
  const spans: SecretSpan[] = [];
  flagSpans(joined, spans);
  argumentSpans(joined, spans);
  shortPasswordSpans(joined, spans);
  commandCredentialSpans(joined, spans);
  if (spans.length === 0) return items;
  const offsets: number[] = [];
  let offset = 0;
  for (const item of items) {
    offsets.push(offset);
    offset += item.length + 1;
  }
  const cuts: TextRange[][] = items.map(() => []);
  for (const span of spans) {
    for (let index = elementAt(offsets, span.start); index < items.length; index += 1) {
      if (offsets[index] >= span.end) break;
      const start = Math.max(span.start, offsets[index]) - offsets[index];
      const end = Math.min(span.end, offsets[index] + items[index].length) - offsets[index];
      if (start < end) cuts[index].push({ start, end });
    }
  }
  return items.map((item, index) => cutRanges(item, cuts[index], ctx));
}

/** The element whose text holds `position` of the joined argv (offsets ascend). */
function elementAt(offsets: number[], position: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle] <= position) low = middle;
    else high = middle - 1;
  }
  return low;
}

function cutRanges(text: string, ranges: TextRange[], ctx: WalkContext): string {
  if (ranges.length === 0) return text;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let result = "";
  let at = 0;
  for (const range of sorted) {
    if (range.start < at) {
      // Overlaps the cut before it: widen that cut, no second marker.
      at = Math.max(at, range.end);
      continue;
    }
    result += text.slice(at, range.start) + marker("argument");
    ctx.count += 1;
    at = range.end;
  }
  return result + text.slice(at);
}

/** A string under a secret-shaped key is a structured assignment: its whole value goes. */
function redactField(key: string, value: unknown, ctx: WalkContext): unknown {
  if (typeof value === "string" && value.length >= MIN_SECRET_LENGTH && isSecretName(key)) {
    ctx.count += 1;
    return marker("assignment");
  }
  return redactValue(value, ctx);
}

interface RedactedRecord {
  record: Record<string, unknown>;
  /** Original key to sent key, for the keys redaction changed. */
  renamed: Map<string, string>;
}

function redactRecord(
  record: Record<string, unknown>,
  ctx: WalkContext,
  redactEntryValue: (key: string, value: unknown) => unknown,
): RedactedRecord {
  const entries: [string, unknown][] = [];
  const sentKeys = new Set<string>();
  const renamed = new Map<string, string>();
  for (const [key, value] of Object.entries(record)) {
    const sentKey = redactText(key, ctx);
    if (sentKeys.has(sentKey)) throw new JevRedactionError("key-collision");
    sentKeys.add(sentKey);
    if (sentKey !== key) renamed.set(key, sentKey);
    entries.push([sentKey, redactEntryValue(key, value)]);
  }
  return { record: Object.fromEntries(entries), renamed };
}

interface RedactedQuestions {
  questions: unknown;
  keyMap: JevKeyMap;
}

function redactQuestions(questions: unknown, ctx: WalkContext): RedactedQuestions {
  if (!isRecord(questions)) return { questions: redactValue(questions, ctx), keyMap: {} };
  const choiceKeys = new Map<string, Map<string, string>>();
  const { record, renamed } = redactRecord(questions, ctx, (id, question) =>
    redactQuestion(question, ctx, (changed) => choiceKeys.set(id, changed)),
  );
  const entries: [string, JevKeyMapEntry][] = [];
  for (const id of Object.keys(questions)) {
    const sentId = renamed.get(id) ?? id;
    const changedKeys = [...(choiceKeys.get(id) ?? [])];
    if (sentId === id && changedKeys.length === 0) continue;
    const criteria = Object.fromEntries(changedKeys.map(([original, sent]) => [sent, original]));
    entries.push([sentId, { id, criteria }]);
  }
  return { questions: record, keyMap: Object.fromEntries(entries) };
}

function redactQuestion(
  question: unknown,
  ctx: WalkContext,
  onChoiceKeys: (renamed: Map<string, string>) => void,
): unknown {
  if (!isRecord(question)) return redactValue(question, ctx);
  return redactRecord(question, ctx, (field, value) => {
    if (field !== "criteria" || !isRecord(value)) return redactField(field, value, ctx);
    // Option names and their descriptions, not assignments: a `pass` option keeps its text.
    const criteria = redactRecord(value, ctx, (_option, description) =>
      redactValue(description, ctx),
    );
    if (question.type === "choice") onChoiceKeys(criteria.renamed);
    return criteria.record;
  }).record;
}

/** Question ids, types and criteria keys: what the exact pass over JSON must not change. */
function questionShape(questions: unknown): string {
  if (!isRecord(questions)) return JSON.stringify(typeof questions);
  const shape = Object.entries(questions).map(([id, question]) => {
    if (!isRecord(question)) return [id];
    const criteria = isRecord(question.criteria) ? Object.keys(question.criteria) : [];
    return [id, question.type, criteria];
  });
  return JSON.stringify(shape);
}

function exactPassOverJson(json: string, ctx: WalkContext): unknown {
  const spans: SecretSpan[] = [];
  exactSpans(json, ctx.secrets, spans);
  const redacted = applySpans(json, { secrets: spans, guards: [], emails: [], homes: [] }, ctx);
  try {
    return JSON.parse(redacted);
  } catch (error) {
    if (error instanceof SyntaxError) throw new JevRedactionError("unparseable");
    throw error;
  }
}

function redactText(text: string, ctx: WalkContext): string {
  const findings: LeafFindings = { secrets: [], guards: [], emails: [], homes: [] };
  pemSpans(text, findings.secrets);
  suffixSpans(text, AUTH_HEADER_RE, "bearer", findings.secrets);
  suffixSpans(text, BEARER_RE, "bearer", findings.secrets);
  wholeSpans(text, TOKEN_RE, "token", findings.secrets);
  suffixSpans(text, WEBHOOK_RE, "webhook", findings.secrets);
  wholeSpans(text, JWT_RE, "jwt", findings.secrets);
  userinfoSpans(text, findings);
  assignmentSpans(text, findings.secrets);
  genericAssignmentSpans(text, findings.secrets);
  flagSpans(text, findings.secrets);
  argumentSpans(text, findings.secrets);
  shortPasswordSpans(text, findings.secrets);
  commandCredentialSpans(text, findings.secrets);
  suffixSpans(text, OPENSSL_PASS_RE, "argument", findings.secrets);
  headerSpans(text, findings.secrets);
  phpDefineSpans(text, findings.secrets);
  wholeSpans(text, PASSWORD_HASH_RE, "hash", findings.secrets);
  entropySpans(text, findings.secrets);
  bareRunSpans(text, findings.secrets);
  exactSpans(text, ctx.secrets, findings.secrets);
  sensitiveValueSpans(text, findings.secrets);
  for (const match of text.matchAll(EMAIL_RE)) {
    findings.emails.push(rangeOf(match));
    pairPasswordSpan(text, rangeOf(match).end, findings.secrets);
  }
  if (ctx.home) {
    for (const match of text.matchAll(ctx.home)) findings.homes.push(rangeOf(match));
  }
  return applySpans(text, findings, ctx);
}

function marker(kind: string): string {
  return `[redacted:${kind}]`;
}

function rangeOf(match: RegExpMatchArray): TextRange {
  const start = match.index ?? 0;
  return { start, end: start + match[0].length };
}

function wholeSpans(text: string, re: RegExp, kind: string, out: SecretSpan[]): void {
  for (const match of text.matchAll(re)) out.push({ ...rangeOf(match), kind });
}

/** The pattern's last capture group ends the match; only that group is replaced. */
function suffixSpans(text: string, re: RegExp, kind: string, out: SecretSpan[]): void {
  for (const match of text.matchAll(re)) {
    const { end } = rangeOf(match);
    out.push({ start: end - match[1].length, end, kind });
  }
}

/**
 * BEGIN to END, or to the end of the text when the END was clipped away. An END with no BEGIN
 * (the head was clipped) takes the base64 lines above it.
 */
function pemSpans(text: string, out: SecretSpan[]): void {
  const begins = [...text.matchAll(PEM_BEGIN_RE)].map(rangeOf);
  const ends = [...text.matchAll(PEM_END_RE)].map(rangeOf);
  let covered = 0;
  let e = 0;
  for (const begin of begins) {
    if (begin.start < covered) continue;
    while (e < ends.length && ends[e].start < begin.start) {
      out.push({
        start: orphanBodyStart(text, ends[e].start, covered),
        end: ends[e].end,
        kind: "pem",
      });
      covered = ends[e].end;
      e += 1;
    }
    const end = e < ends.length ? ends[e].end : text.length;
    out.push({ start: begin.start, end, kind: "pem" });
    covered = end;
    e += 1;
  }
  for (; e < ends.length; e += 1) {
    out.push({
      start: orphanBodyStart(text, ends[e].start, covered),
      end: ends[e].end,
      kind: "pem",
    });
    covered = ends[e].end;
  }
}

function orphanBodyStart(text: string, endStart: number, floor: number): number {
  const from = Math.max(floor, endStart - PEM_MAX_BODY);
  const above = text.slice(from, endStart);
  const lines: TextRange[] = [];
  let lineStart = 0;
  for (const match of above.matchAll(LINE_BREAK_RE)) {
    const { start, end } = rangeOf(match);
    lines.push({ start: lineStart, end: start });
    lineStart = end;
  }
  lines.push({ start: lineStart, end: above.length });
  let bodyStart = above.length;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!PEM_BODY_LINE_RE.test(above.slice(lines[i].start, lines[i].end))) break;
    bodyStart = lines[i].start;
  }
  return from + bodyStart;
}

function userinfoSpans(text: string, findings: LeafFindings): void {
  for (const match of text.matchAll(USERINFO_RE)) {
    const at = rangeOf(match).end - 1;
    const start = at - match[1].length - 1 - match[2].length;
    findings.secrets.push({ start, end: at, kind: "userinfo" });
    findings.guards.push({ start, end: at });
  }
}

/**
 * `NAME=value`, `export NAME=value`, `"name": "value"`, `name: value`, `_authToken=value`. A
 * YAML password key at the start of a line takes its words to the end of the line. The search resumes
 * after each value it read, so `token=token=…` stays linear.
 */
function assignmentSpans(text: string, out: SecretSpan[]): void {
  const re = new RegExp(ASSIGNMENT_NAME_RE);
  for (let match = re.exec(text); match; match = re.exec(text)) {
    const word = lastNameWord(match[1]);
    if (SHORT_SECRET_NAME_RE.test(word)) {
      const value = assignedValue(text, re.lastIndex);
      if (value.end - value.start >= MIN_SHORT_SECRET_LENGTH)
        out.push({ ...value, kind: "assignment" });
      re.lastIndex = Math.max(re.lastIndex, value.end);
      continue;
    }
    if (PAIR_NAME_RE.test(word)) {
      const value = assignedValue(text, re.lastIndex);
      const colon = text.slice(value.start, value.end).indexOf(":");
      if (colon !== -1 && value.end - (value.start + colon + 1) >= MIN_SHORT_SECRET_LENGTH) {
        out.push({ start: value.start + colon + 1, end: value.end, kind: "assignment" });
      }
      re.lastIndex = Math.max(re.lastIndex, value.end);
      continue;
    }
    if (!isSecretName(match[1])) {
      base64ValueSpan(text, re.lastIndex, out);
      continue;
    }
    const passphrase = PASSPHRASE_NAME_RE.test(match[1]);
    const yamlLine = match[2] === ":" && passphrase && startsLine(text, match.index);
    // `NAME=value` runs to the end of the line: `ADMIN_PASSWORD=correct horse battery`,
    // `DB_PASSWORD=hunter2 npm start`. A comparison (`token == x`) is not an assignment.
    const envLine = match[2] === "=" && text[re.lastIndex] !== "=";
    const value =
      yamlLine || envLine ? lineValue(text, re.lastIndex) : assignedValue(text, re.lastIndex);
    // A password set with `=` is often short: `PGPASSWORD=abc123 psql`.
    const floor = envLine && passphrase ? MIN_SHORT_SECRET_LENGTH : MIN_SECRET_LENGTH;
    const valueText = text.slice(value.start, value.end);
    if (value.end - value.start >= floor && !PLACEHOLDER_VALUE_RE.test(valueText)) {
      out.push({ ...value, kind: "assignment" });
    }
    re.lastIndex = Math.max(re.lastIndex, value.end);
  }
}

/** A name's last `_`/`-`/`.` segment, or that segment's last camelCase word: `ADMIN_PIN`, `adminPin`. */
function lastNameWord(name: string): string {
  const lastSegment = name.split(/[_.-]/).findLast((segment) => segment.length > 0) ?? "";
  if (SHORT_SECRET_NAME_RE.test(lastSegment) || PAIR_NAME_RE.test(lastSegment)) return lastSegment;
  return LAST_CAMEL_WORD_RE.exec(lastSegment)?.[0] ?? "";
}

/** Any name: a whole value shaped like a base64 key, `INTERNAL_SIGNING=Zm9v…`. */
function base64ValueSpan(text: string, from: number, out: SecretSpan[]): void {
  BASE64_VALUE_RE.lastIndex = from;
  const match = BASE64_VALUE_RE.exec(text);
  if (!match) return;
  const run = match[1].replace(/=+$/, "");
  const mixed = /[0-9]/.test(run) && /[A-Z]/.test(run) && /[a-z]/.test(run);
  if (!mixed || classChangeRatio(run) < MIN_CLASS_CHANGE_RATIO) return;
  const end = from + match[0].length;
  out.push({ start: end - match[1].length, end, kind: "entropy" });
}

/** The password of `user@host:password`, right after the email address ends; a port is not one. */
function pairPasswordSpan(text: string, emailEnd: number, out: SecretSpan[]): void {
  PAIR_PASSWORD_RE.lastIndex = emailEnd;
  const match = PAIR_PASSWORD_RE.exec(text);
  if (match && !/^\d+$/.test(match[1])) {
    out.push({ start: emailEnd + 1, end: emailEnd + match[0].length, kind: "userinfo" });
  }
}

/**
 * Terraform state and JSON like it: a `"value"` in an object marked `"sensitive": true`, or under
 * a secret-shaped key (`"admin_token": {"value": …}`). The object is looked at 256 characters
 * either side, so the scan stays linear.
 */
function sensitiveValueSpans(text: string, out: SecretSpan[]): void {
  for (const match of text.matchAll(JSON_VALUE_RE)) {
    const { start, end } = rangeOf(match);
    const before = text.slice(Math.max(0, start - OBJECT_CONTEXT_CHARS), start);
    const after = text.slice(end, end + OBJECT_CONTEXT_CHARS);
    const objectBefore = before.slice(before.lastIndexOf("{"));
    const objectAfter = after.slice(0, after.includes("}") ? after.indexOf("}") : after.length);
    const parent = VALUE_PARENT_RE.exec(before)?.[1];
    if (
      SENSITIVE_RE.test(objectBefore) ||
      SENSITIVE_RE.test(objectAfter) ||
      (parent !== undefined && isSecretName(parent))
    ) {
      out.push({ start: end - 1 - match[1].length, end: end - 1, kind: "assignment" });
    }
  }
}

function startsLine(text: string, at: number): boolean {
  LINE_START_RE.lastIndex = at;
  return LINE_START_RE.test(text);
}

/** A quoted value as `assignedValue` reads it; a bare one runs to the end of the line. */
function lineValue(text: string, from: number): TextRange {
  if (QUOTE_START_RE.test(text.slice(from, from + 1))) return assignedValue(text, from);
  LINE_VALUE_RE.lastIndex = from;
  return { start: from, end: from + (LINE_VALUE_RE.exec(text)?.[0].length ?? 0) };
}

/**
 * `--token X`, `--password=X`, `-authtoken X`, and the same flag inside a JSON argv array. The
 * search resumes after every value it read, kept or not, so `--password=--password=…` stays
 * linear; an option where the value would be is not read, so it is still searched.
 */
function flagSpans(text: string, out: SecretSpan[]): void {
  const re = new RegExp(FLAG_RE);
  for (let match = re.exec(text); match; match = re.exec(text)) {
    if (!isSecretName(match[1])) continue;
    const value = argumentValue(text, re.lastIndex);
    if (!value) continue;
    re.lastIndex = Math.max(re.lastIndex, value.end);
    // An option names its value, so a short one is still the secret: `--password=hunter2`.
    if (isSecretArgument(text.slice(value.start, value.end), MIN_SHORT_SECRET_LENGTH))
      out.push({ ...value, kind: "argument" });
  }
}

/**
 * A bare secret name followed by its value: `aws configure set aws_secret_access_key X`,
 * `ngrok config add-authtoken X`, `npm config set _authToken X`. Prose puts plain words after
 * a name ("the GITHUB_TOKEN variable"), so the value needs a character that is not a letter.
 */
function argumentSpans(text: string, out: SecretSpan[]): void {
  const re = new RegExp(ARGUMENT_NAME_RE);
  for (let match = re.exec(text); match; match = re.exec(text)) {
    const name = match[1];
    if (PROSE_SECRET_WORD_RE.test(name) || !isSecretName(name)) continue;
    const value = argumentValue(text, re.lastIndex);
    if (!value) continue;
    re.lastIndex = Math.max(re.lastIndex, value.end);
    const argument = text.slice(value.start, value.end);
    if (isSecretArgument(argument) && /[^A-Za-z]/.test(argument)) {
      out.push({ ...value, kind: "argument" });
    }
  }
}

/** The value after a flag or an argument's name, or null when another option follows. */
function argumentValue(text: string, from: number): TextRange | null {
  OPTION_AHEAD_RE.lastIndex = from;
  return OPTION_AHEAD_RE.test(text) ? null : assignedValue(text, from);
}

function isSecretArgument(value: string, floor = MIN_SECRET_LENGTH): boolean {
  return (
    value.length >= floor &&
    !NOT_SECRET_ARGUMENT_RE.test(value) &&
    !PLACEHOLDER_VALUE_RE.test(value)
  );
}

/**
 * `-p` after a command that means a password by it (`mysql -pX`, `docker login -p X`), at any
 * length. Each command's search stops where the command ends and the next command's search
 * starts there, so the text is read once.
 */
function shortPasswordSpans(text: string, out: SecretSpan[]): void {
  const commands = new RegExp(PASSWORD_COMMAND_RE);
  const ends = new RegExp(COMMAND_END_RE);
  const flags = new RegExp(SHORT_PASSWORD_FLAG_RE);
  for (let command = commands.exec(text); command; command = commands.exec(text)) {
    const attachedOnly = command[1] !== undefined;
    const from = commands.lastIndex;
    ends.lastIndex = from;
    const end = ends.exec(text)?.index ?? text.length;
    flags.lastIndex = 0;
    const segment = text.slice(from, end);
    for (let flag = flags.exec(segment); flag; flag = flags.exec(segment)) {
      let valueFrom = from + flags.lastIndex;
      if (!attachedOnly) {
        PASSWORD_FLAG_GAP_RE.lastIndex = valueFrom;
        if (PASSWORD_FLAG_GAP_RE.test(text)) valueFrom = PASSWORD_FLAG_GAP_RE.lastIndex;
      }
      const value = assignedValue(text, valueFrom);
      if (value.end > value.start) out.push({ ...value, kind: "argument" });
    }
    commands.lastIndex = Math.max(commands.lastIndex, end);
  }
}

/**
 * The table's options after their commands (`curl -u admin:pw`, `redis-cli -a pw`), within the
 * command, as `shortPasswordSpans` reads `-p`.
 */
function commandCredentialSpans(text: string, out: SecretSpan[]): void {
  for (const rule of PAIR_COMMAND_RULES) {
    const commands = new RegExp(rule.commands);
    const ends = new RegExp(COMMAND_END_RE);
    const flags = new RegExp(rule.flag);
    for (let command = commands.exec(text); command; command = commands.exec(text)) {
      const from = commands.lastIndex;
      ends.lastIndex = from;
      const end = ends.exec(text)?.index ?? text.length;
      const segment = text.slice(from, end);
      flags.lastIndex = 0;
      for (let flag = flags.exec(segment); flag; flag = flags.exec(segment)) {
        let valueFrom = from + flags.lastIndex;
        PASSWORD_FLAG_GAP_RE.lastIndex = valueFrom;
        if (PASSWORD_FLAG_GAP_RE.test(text)) valueFrom = PASSWORD_FLAG_GAP_RE.lastIndex;
        else if (!rule.attached) continue;
        const value = assignedValue(text, valueFrom);
        if (value.end <= value.start) continue;
        const span = rule.pair ? pairSecret(text, value) : value;
        if (span) out.push({ ...span, kind: "argument" });
      }
      commands.lastIndex = Math.max(commands.lastIndex, end);
    }
  }
}

/** The password of a `user:password` value, or the whole value when it holds no password. */
function pairSecret(text: string, value: TextRange): TextRange | null {
  const colon = text.slice(value.start, value.end).indexOf(":");
  if (colon === -1) return null;
  const password = { start: value.start + colon + 1, end: value.end };
  return password.end > password.start ? password : { start: value.start, end: value.end };
}

function headerSpans(text: string, out: SecretSpan[]): void {
  for (const match of text.matchAll(HEADER_FLAG_RE)) {
    const name = match[1];
    if (!CREDENTIAL_HEADER_RE.test(name) && !isSecretName(name)) continue;
    const { end } = rangeOf(match);
    const value = match[2].replace(/[ \t]+$/, "");
    const start = end - match[2].length;
    if (value.length > 0) out.push({ start, end: start + value.length, kind: "argument" });
  }
}

function phpDefineSpans(text: string, out: SecretSpan[]): void {
  for (const match of text.matchAll(PHP_DEFINE_RE)) {
    if (!isSecretName(match[1])) continue;
    const { start } = rangeOf(match);
    const valueStart = start + match[0].lastIndexOf(match[3]);
    out.push({ start: valueStart, end: valueStart + match[3].length, kind: "assignment" });
  }
}

function assignedValue(text: string, from: number): TextRange {
  for (const re of VALUE_RES) {
    re.lastIndex = from;
    const match = re.exec(text);
    if (!match) continue;
    const end = from + match[0].length;
    return { start: end - match[1].length, end };
  }
  return { start: from, end: from };
}

function genericAssignmentSpans(text: string, out: SecretSpan[]): void {
  for (const match of text.matchAll(GENERIC_ASSIGNMENT_RE)) {
    const { end } = rangeOf(match);
    // An escaped closing quote (`\"`) belongs to the text around the value.
    const valueEnd = text[end - 1] === "\\" && text[end] === '"' ? end - 1 : end;
    out.push({ start: end - match[1].length, end: valueEnd, kind: "assignment" });
  }
}

/** A value after `=`, `:` or `Bearer`, such as `cookie=…`; a path there is judged by segment. */
function entropySpans(text: string, out: SecretSpan[]): void {
  for (const match of text.matchAll(ENTROPY_RE)) {
    const run = match[1];
    if (DIGEST_RE.test(run)) continue;
    const { end } = rangeOf(match);
    const padding = match[0].length - match[0].replace(/=+$/, "").length;
    const start = end - padding - run.length;
    if (isPath(run)) pathSegmentSpans(run, start, out);
    else if (isHighEntropy(run)) out.push({ start, end, kind: "entropy" });
  }
}

/** A relative path (`app/src/main/MainActivity`) reaches 4 bits too, but changes class rarely. */
function isHighEntropy(run: string): boolean {
  if (shannonEntropy(run) < MIN_ENTROPY_BITS) return false;
  if (!run.includes("/")) return true;
  return classChangeRatio(run) >= MIN_CLASS_CHANGE_RATIO || decodesToText(run);
}

/** A standalone run of 40 or more base64 characters, or 64 or more hex. */
function bareRunSpans(text: string, out: SecretSpan[]): void {
  for (const match of text.matchAll(BARE_RUN_RE)) {
    const run = match[0].replace(/=+$/, "");
    if (DIGEST_RE.test(run)) continue;
    const range = rangeOf(match);
    if (isPath(run)) pathSegmentSpans(run, range.start, out);
    else if (isSecretRun(run)) out.push({ ...range, kind: "entropy" });
  }
}

/**
 * An absolute path, or a run with `/` and `-` or `_`, which no base64 alphabet has together. A
 * base64 value that starts with `/` is read as a path too, and only its long segments are judged.
 */
function isPath(run: string): boolean {
  return run.startsWith("/") || (run.includes("/") && (run.includes("-") || run.includes("_")));
}

/** Each segment is judged as a bare run: a UUID directory must not make the path look random. */
function pathSegmentSpans(path: string, start: number, out: SecretSpan[]): void {
  let at = start;
  for (const segment of path.split("/")) {
    if (segment.length >= MIN_BARE_RUN_LENGTH && isSecretRun(segment)) {
      out.push({ start: at, end: at + segment.length, kind: "entropy" });
    }
    at += segment.length + 1;
  }
}

function isSecretRun(run: string): boolean {
  if (HEX_RE.test(run)) return run.length >= MIN_HEX_SECRET_LENGTH;
  const random =
    shannonEntropy(run) >= MIN_BARE_ENTROPY_BITS && classChangeRatio(run) >= MIN_CLASS_CHANGE_RATIO;
  return random || decodesToText(run);
}

function classChangeRatio(run: string): number {
  let changes = 0;
  for (let i = 1; i < run.length; i += 1) {
    if (charClass(run[i]) !== charClass(run[i - 1])) changes += 1;
  }
  return changes / (run.length - 1);
}

function charClass(char: string): number {
  if (char >= "a" && char <= "z") return 0;
  if (char >= "A" && char <= "Z") return 1;
  if (char >= "0" && char <= "9") return 2;
  return 3;
}

/** Node's base64 decoder reads both the standard and the URL-safe alphabet. */
function decodesToText(run: string): boolean {
  const bytes = Buffer.from(run, "base64");
  if (bytes.length < MIN_DECODED_BYTES) return false;
  let printable = 0;
  for (const byte of bytes) {
    if ((byte >= 0x20 && byte < 0x7f) || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      printable += 1;
    }
  }
  return printable / bytes.length >= MIN_PRINTABLE_RATIO;
}

function shannonEntropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function exactSpans(text: string, secrets: JevExactSecretSet, out: SecretSpan[]): void {
  const forms = EXACT_FORMS.get(secrets);
  if (!forms) throw new Error("JevExactSecretSet was not constructed");
  for (const { kind, value } of forms) {
    for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) {
      out.push({ start: at, end: at + value.length, kind });
    }
  }
}

function jsonForms(value: string): string[] {
  const once = JSON.stringify(value).slice(1, -1);
  const twice = JSON.stringify(once).slice(1, -1);
  return [...new Set([value, once, twice])];
}

/**
 * The home directory as written raw, JSON-escaped once or twice, or with forward slashes, at a
 * path boundary. Null for a root or empty home, which would turn every path into `~`.
 */
function homePattern(homeDir: string): RegExp | null {
  const home = homeDir.replace(/[\\/]+$/, "");
  if (!/[\\/][^\\/]/.test(home)) return null;
  const forms = [...new Set([...jsonForms(home), home.replaceAll("\\", "/")])];
  forms.sort((a, b) => b.length - a.length);
  return new RegExp(`(?<![\\w.-])(?:${forms.map(escapeRegExp).join("|")})(?![\\w.-])`, "gi");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * Secrets first, merged where they overlap; then emails that touch no secret; then home
 * prefixes that touch neither. Counts each merged secret and each email.
 */
function applySpans(text: string, findings: LeafFindings, ctx: WalkContext): string {
  clipAtUserinfo(findings.secrets, findings.guards);
  const secrets = mergeSecrets(findings.secrets);
  const emails = outside(findings.emails, secrets);
  const homes = outside(findings.homes, sortByStart([...secrets, ...emails]));
  ctx.count += secrets.length + emails.length;
  const replacements = [
    ...secrets.map((span) => replacementOf(span, marker(span.kind))),
    ...emails.map((span) => replacementOf(span, "[email]")),
    ...homes.map((span) => replacementOf(span, "~")),
  ];
  if (replacements.length === 0) return text;
  sortByStart(replacements);
  let result = "";
  let cursor = 0;
  for (const replacement of replacements) {
    result += text.slice(cursor, replacement.start) + replacement.text;
    cursor = replacement.end;
  }
  return result + text.slice(cursor);
}

interface Replacement extends TextRange {
  text: string;
}

function replacementOf(range: TextRange, text: string): Replacement {
  return { start: range.start, end: range.end, text };
}

/** Guards arrive in text order and never overlap. */
function clipAtUserinfo(spans: SecretSpan[], guards: UserinfoGuard[]): void {
  let g = 0;
  for (const span of sortByStart(spans)) {
    while (g < guards.length && guards[g].end <= span.start) g += 1;
    if (g < guards.length && guards[g].start <= span.start && span.end > guards[g].end) {
      span.end = guards[g].end;
    }
  }
}

function sortByStart<T extends TextRange>(spans: T[]): T[] {
  return spans.sort((a, b) => a.start - b.start || b.end - a.end);
}

/** Overlapping spans become one, named by the one that starts first (then the longest). */
function mergeSecrets(spans: SecretSpan[]): SecretSpan[] {
  const merged: SecretSpan[] = [];
  for (const span of sortByStart(spans)) {
    const last = merged.at(-1);
    if (last && span.start < last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/** Candidates that overlap no blocker. Both sorted by start; blockers do not overlap each other. */
function outside(candidates: TextRange[], blockers: TextRange[]): TextRange[] {
  const kept: TextRange[] = [];
  let b = 0;
  for (const candidate of sortByStart(candidates)) {
    while (b < blockers.length && blockers[b].end <= candidate.start) b += 1;
    const blocked = b < blockers.length && blockers[b].start < candidate.end;
    if (!blocked) kept.push(candidate);
  }
  return kept;
}
