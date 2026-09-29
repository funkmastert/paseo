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
  /^(?:secret|token|passw(?:or)?d|pwd|pass|api[_-]?key|key|auth|credentials?|private[_-]?key|pat|dsn)$/i;

const MIN_SECRET_LENGTH = 8;
const SAFE_KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;
const LAST_CAMEL_WORD_RE = /(?:[A-Z][a-z0-9]+|[A-Z]+|[a-z0-9]+)$/;

/**
 * The doc's secret-name rule: the name, its last `_`/`-`/`.` segment, or that segment's last
 * camelCase word (`apiKey`, `_authToken`), or a database URL (`DATABASE_URL`, `sentryDsnUrl`).
 */
export function isSecretName(name: string): boolean {
  if (SECRET_NAME_RE.test(name)) return true;
  const lastSegment = name.split(/[_.-]/).findLast((segment) => segment.length > 0) ?? "";
  if (SECRET_NAME_RE.test(lastSegment)) return true;
  const lastWord = LAST_CAMEL_WORD_RE.exec(lastSegment)?.[0] ?? "";
  if (SECRET_NAME_RE.test(lastWord)) return true;
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
  /(?<![A-Za-z0-9_-])(?:(?:sk-ant-|sk-or-|sk-|sk_live_|rk_live_|gh[pousr]_|github_pat_|glpat-|xox[abeprs]-|tskey-)[A-Za-z0-9_-]{16,}|npm_[a-z0-9]{36,}|ya29\.[A-Za-z0-9_.-]{16,}|(?:akia|asia)[a-z0-9]{16}(?![a-z0-9])|aiza[a-z0-9_-]{30,})/gi;
const JWT_RE = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/gi;
const USERINFO_RE =
  /(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\/([^\s/?#@:"'<>\\]{1,256}):([^\s/?#@"'<>\\]{1,256})@/gi;
/** A name and its separator; the value is read by `assignedValue`. */
const ASSIGNMENT_NAME_RE =
  /(?<![\w.$-])\\?["']?([A-Za-z_][\w.-]{0,63})\\?["']?[ \t]{0,16}[:=][ \t]{0,16}/g;
const GENERIC_ASSIGNMENT_RE =
  /(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|auth|credential|private[_-]?key)\\?["']?\s{0,32}[:=]\s{0,32}\\?["']?([^\s"',]{8,})/gi;
const ENTROPY_RE = /(?:[=:]|bearer[ \t]{1,16})[ \t]{0,16}\\?["']?([A-Za-z0-9+/_-]{32,})={0,2}/gi;
const MIN_ENTROPY_BITS = 4;
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
  if (Array.isArray(value)) return value.map((item) => redactValue(item, ctx));
  if (isRecord(value))
    return redactRecord(value, ctx, (key, item) => redactField(key, item, ctx)).record;
  return value;
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
  wholeSpans(text, JWT_RE, "jwt", findings.secrets);
  userinfoSpans(text, findings);
  assignmentSpans(text, findings.secrets);
  genericAssignmentSpans(text, findings.secrets);
  entropySpans(text, findings.secrets);
  exactSpans(text, ctx.secrets, findings.secrets);
  for (const match of text.matchAll(EMAIL_RE)) findings.emails.push(rangeOf(match));
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
 * `NAME=value`, `export NAME=value`, `"name": "value"`, `name: value`, `_authToken=value`. The
 * search resumes after each value it read, so `token=token=…` stays linear.
 */
function assignmentSpans(text: string, out: SecretSpan[]): void {
  const re = new RegExp(ASSIGNMENT_NAME_RE);
  for (let match = re.exec(text); match; match = re.exec(text)) {
    if (!isSecretName(match[1])) continue;
    const value = assignedValue(text, re.lastIndex);
    if (value.end - value.start >= MIN_SECRET_LENGTH) out.push({ ...value, kind: "assignment" });
    re.lastIndex = Math.max(re.lastIndex, value.end);
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

function entropySpans(text: string, out: SecretSpan[]): void {
  for (const match of text.matchAll(ENTROPY_RE)) {
    const run = match[1];
    if (shannonEntropy(run) < MIN_ENTROPY_BITS) continue;
    const { end } = rangeOf(match);
    const padding = match[0].length - match[0].replace(/=+$/, "").length;
    out.push({ start: end - padding - run.length, end, kind: "entropy" });
  }
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
