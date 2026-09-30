import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";

import { JEV_TOOLS_LABEL } from "@getpaseo/protocol/agent-labels";
import type {
  CommandGate,
  JevAnswer,
  JevEgressScope,
  JevFailureReason,
  JevOutcome,
  JevQuestions,
  JevService,
  JevState,
  JevUnavailableReason,
} from "../../jev/contract.js";
import { choice, noul, score, validateJevRequest } from "../../jev/wire.js";
import { runJevCommand, type JevCommandOutput } from "./jev-command.js";
import {
  collectDiff,
  deterministicTriggers,
  DIFF_RISK_QUESTIONS,
  scoreDiffRisk,
  type DiffRiskResult,
} from "./jev-diff-risk.js";
import {
  JEV_FILES_CAP,
  JevFileScope,
  readCallerDenials,
  type JevFileContent,
  type JevFileRef,
  type JevFileSkip,
  type JevGitRunner,
} from "./jev-file-state.js";
import {
  estimateReadTokens,
  type JevToolName,
  type JevToolUseLog,
  type JevToolUseOutcome,
  type JevToolUseRecord,
} from "./jev-tool-use-log.js";
import type { PaseoToolConfig, PaseoToolExecutionContext, PaseoToolResult } from "./types.js";

/**
 * The JEV agent tools (docs/jev.md, "Features 4–6"): code reads the files or runs the command,
 * sends them to JEV, and returns typed answers, so the content never enters the agent's context.
 * The pattern is disler/ten-levels-of-jev levels 8–10 (MIT). Offered only to agents labelled
 * `paseo.jev-tools: on` at create; nothing here gates the agent (D1): every refusal names why and
 * the agent does what it would have done without the tool.
 */

export const JEV_TOOLS_LABEL_ON = "on";
const TOOLS_DENIED_LABEL = "paseo.tools-denied";

/** A result stays in the agent's context for the rest of its session; ~2K tokens by default. */
export const JEV_TOOL_RESULT_CAP = 8_000;
/** The ceiling even with `all` or `include_probabilities`. */
export const JEV_TOOL_RESULT_HARD_CAP = 24_000;
/** JEV's state cap in `jev/service.ts`, measured the same way: UTF-8 bytes of the JSON. */
const STATE_MAX_BYTES = 60_000;
const OWN_STATE_MAX_BYTES = 8_000;
const ASK_JEV_MAX_FILES = 20;
const ASK_FILES_DEFAULT_TOP = 20;
const ASK_FILES_CONCURRENCY = 2;
const ASK_FILES_BUDGET_MS = 60_000;
const PICK_FIRST_FLOOR = 0.3;
const PICK_FIRST_MAX_CANDIDATES = 254;
const SKIPPED_SHOWN = 20;
const MAX_CHOICE_OPTIONS = 255;

const USE_READ =
  "Use Read when you need the code itself, to edit or quote it. Use grep for exact strings.";

export interface JevToolsDependencies {
  jev: JevService;
  /** `createCatastropheCommandGate` from `jev/command-gate.ts`. Null refuses every `command`. */
  commandGate: CommandGate | null;
  paseoHome: string;
  /** The D8 record. Absent in tests that do not measure. */
  useLog?: JevToolUseLog | null;
  homeDir?: string;
  platform?: NodeJS.Platform;
  runGit?: JevGitRunner;
  now?: () => number;
  /** Test seam: the environment `command` starts from; the JEV key is stripped from it either way. */
  commandBaseEnv?: NodeJS.ProcessEnv;
}

/** What a tool needs to know about its caller, read fresh at every call. */
export interface JevToolCaller {
  id: string;
  cwd: string;
  labels: Readonly<Record<string, string>>;
  providerOptions?: unknown;
  /** The context the extra model step re-reads (`lastUsage.contextWindowUsedTokens`). */
  contextTokens: number | null;
}

type RegisterTool = (
  name: string,
  config: PaseoToolConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tool inputs are validated by the catalog before execution.
  handler: (input: any, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>,
) => void;

export interface RegisterJevToolsOptions {
  registerTool: RegisterTool;
  deps: JevToolsDependencies;
  callerAgentId: string;
  /** Null when the agent is gone; never throws. */
  readCallerAgent: () => JevToolCaller | null;
  logger: Logger;
}

export function hasJevToolsLabel(
  labels: Readonly<Record<string, string>> | null | undefined,
): boolean {
  return labels?.[JEV_TOOLS_LABEL] === JEV_TOOLS_LABEL_ON;
}

// ---------------------------------------------------------------------------------------------
// Questions from the agent

const InstructionsSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);
const QuestionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("noul"),
    instructions: InstructionsSchema,
    criteria: z
      .object({ true: z.string().optional(), false: z.string().optional() })
      .strict()
      .optional(),
  }),
  z.object({
    type: z.literal("choice"),
    instructions: InstructionsSchema,
    criteria: z.record(z.string(), z.string().nullable()),
  }),
  z.object({
    type: z.literal("score"),
    instructions: InstructionsSchema,
    criteria: z.array(z.string()),
  }),
]);
const QuestionsSchema = z.record(z.string().min(1), QuestionSchema);

const QuestionsJsonInput = z
  .union([z.string(), z.record(z.string(), z.unknown())])
  .describe(
    'A JSON object keyed by question id; each question is {"type":"noul"|"choice"|"score","instructions":…,"criteria":…}.',
  );

type ParsedQuestions = { ok: true; questions: JevQuestions } | { ok: false; reason: string };

export function parseQuestionsJson(raw: unknown): ParsedQuestions {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch (error) {
      return { ok: false, reason: `questions_json is not valid JSON: ${(error as Error).message}` };
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "questions_json must be an object keyed by question id" };
  }
  const parsed = QuestionsSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: `questions_json: ${issue?.path.join(".") || "question"}: ${issue?.message ?? "invalid"}`,
    };
  }
  const questions = parsed.data as JevQuestions;
  const invalid = validateJevRequest(questions);
  if (invalid) return { ok: false, reason: `questions_json: ${invalid}` };
  return { ok: true, questions };
}

// ---------------------------------------------------------------------------------------------
// Answers to the agent

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function roundedMap(map: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(map).map(([key, value]) => [key, round3(value)]));
}

/** `{ noul }`, `{ choice, confidence }` or `{ score, confidence }`; the maps only on request. */
export function compactAnswer(
  answer: JevAnswer,
  withProbabilities: boolean,
): Record<string, unknown> {
  if (answer.type === "noul") return { noul: round3(answer.noul) };
  if (answer.type === "choice") {
    return {
      choice: answer.choice,
      confidence: round3(answer.confidence),
      ...(withProbabilities ? { probabilities: roundedMap(answer.probabilities) } : {}),
    };
  }
  return {
    score: round3(answer.score),
    confidence: round3(answer.confidence),
    ...(withProbabilities ? { probabilities: roundedMap(answer.probabilities) } : {}),
  };
}

function compactAnswers(
  answers: Record<string, JevAnswer>,
  withProbabilities: boolean,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(answers).map(([id, answer]) => [id, compactAnswer(answer, withProbabilities)]),
  );
}

const UNAVAILABLE_TEXT: Record<JevUnavailableReason, string> = {
  "no-key": "JEV is off on this host: no key",
  disabled: "JEV is switched off on this host",
  "feature-disabled": "the JEV agent tools are switched off on this host",
  "daily-budget": "the JEV agent tools have spent today's budget",
  "agent-budget": "you have spent your JEV budget for this hour",
  "key-rejected": "JEV rejected this host's key",
  "circuit-open": "JEV is failing right now",
  saturated: "JEV is busy",
  excluded: "company code is not sent to JEV",
  "config-unreadable": "JEV's config cannot be read on this host",
};

const FAILED_TEXT: Record<JevFailureReason, string> = {
  timeout: "JEV timed out",
  aborted: "the call was cancelled",
  http: "JEV answered with an error",
  network: "JEV could not be reached",
  contract: "JEV's answer was malformed",
  "state-too-large": "the content is over JEV's 60,000-byte state",
  "request-too-large": "the questions and content are over JEV's 64,000-byte request",
  "invalid-request": "the questions are not valid JEV questions",
  redaction: "redaction failed, so nothing was sent",
};

// ---------------------------------------------------------------------------------------------
// One tool call

interface ToolAnswer {
  payload: unknown;
  isError: boolean;
  outcome: JevToolUseOutcome;
  reason: string | null;
}

class ToolCall {
  readonly id = randomUUID();
  jevCalls = 0;
  jevAnswered = 0;
  jevUsd = 0;
  jevInputTokens = 0;
  readTokensAvoided = 0;
  paths: string[] = [];
  commandSha256: string | null = null;
  diffRisk: JevToolUseRecord["diffRisk"] = null;

  constructor(
    readonly tool: JevToolName,
    readonly caller: JevToolCaller,
    readonly startedAt: number,
    readonly signal: AbortSignal | undefined,
  ) {}

  count(outcome: JevOutcome): void {
    this.jevCalls += 1;
    if (outcome.kind === "answered") this.jevAnswered += 1;
    const meta = outcome.kind === "unavailable" ? null : outcome.meta;
    if (meta) {
      this.jevUsd += meta.cost.usd ?? 0;
      this.jevInputTokens += meta.inputTokens;
    }
  }

  sent(files: JevFileContent[]): void {
    for (const file of files) {
      this.readTokensAvoided += estimateReadTokens(file.content);
      if (this.paths.length < JEV_FILES_CAP) this.paths.push(file.absolutePath);
    }
  }
}

function ok(payload: unknown): ToolAnswer {
  return { payload, isError: false, outcome: "answered", reason: null };
}

function refused(reason: string): ToolAnswer {
  return { payload: `${reason}.`, isError: true, outcome: "refused", reason };
}

function fellBack(
  outcome: Exclude<JevOutcome, { kind: "answered" | "shadow" }>,
  text: string,
): ToolAnswer {
  return {
    payload: `${text}. Use Read or Bash.`,
    isError: true,
    outcome: outcome.kind === "unavailable" ? "unavailable" : "failed",
    reason: outcome.reason,
  };
}

/** Serialized, and cut to the cap. Payloads that can shrink do so before they get here. */
function toResult(answer: ToolAnswer): PaseoToolResult {
  const text = typeof answer.payload === "string" ? answer.payload : JSON.stringify(answer.payload);
  const capped =
    text.length > JEV_TOOL_RESULT_HARD_CAP
      ? `${text.slice(0, JEV_TOOL_RESULT_HARD_CAP)}… [cut at ${JEV_TOOL_RESULT_HARD_CAP} characters]`
      : text;
  return {
    content: [{ type: "text", text: capped }],
    ...(answer.isError ? { isError: true } : {}),
  };
}

export function registerJevTools(options: RegisterJevToolsOptions): void {
  const { deps, logger } = options;
  const jev = deps.jev;
  const now = deps.now ?? Date.now;
  const homeDir = deps.homeDir ?? os.homedir();
  const platform = deps.platform ?? process.platform;
  const log = logger.child({ component: "jev-tools" });

  function localResetTime(): string {
    try {
      const iso = jev.status().lanes.agentTools.resetsAt;
      return new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "local midnight";
    }
  }

  function outcomeText(outcome: Exclude<JevOutcome, { kind: "answered" | "shadow" }>): string {
    if (outcome.kind === "failed")
      return FAILED_TEXT[outcome.reason] ?? `JEV failed (${outcome.reason})`;
    const text = UNAVAILABLE_TEXT[outcome.reason] ?? `JEV is unavailable (${outcome.reason})`;
    if (outcome.reason === "daily-budget") return `${text}; it resets at ${localResetTime()} local`;
    if (outcome.reason === "agent-budget") return `${text}; it frees up within the hour`;
    return text;
  }

  /** Why JEV cannot answer right now, or null when it can. Checked before reading anything. */
  function inactiveOutcome(): Extract<JevOutcome, { kind: "unavailable" }> | null {
    if (jev.isActive("agentTools")) return null;
    let reason: JevUnavailableReason = "disabled";
    try {
      const status = jev.status();
      const lane = status.lanes.agentTools;
      if (!status.available && status.reason) reason = status.reason;
      else if (!status.features.agentTools.enabled) reason = "feature-disabled";
      else if (lane.exhausted) reason = "daily-budget";
      else if (lane.circuit === "open") reason = "circuit-open";
    } catch {
      reason = "disabled";
    }
    return { kind: "unavailable", callId: "", reason };
  }

  function unanswered(
    outcome: JevOutcome,
  ): outcome is Exclude<JevOutcome, { kind: "answered" | "shadow" }> {
    return outcome.kind === "unavailable" || outcome.kind === "failed";
  }

  async function decide(
    call: ToolCall,
    input: {
      state: JevState;
      questions: JevQuestions;
      scope: JevEgressScope;
      signal?: AbortSignal;
    },
  ): Promise<JevOutcome> {
    const outcome = await jev.decide({
      feature: "agentTools",
      callSite: `tools.${call.tool}`,
      state: input.state,
      questions: input.questions,
      scope: input.scope,
      subject: { callerAgentId: call.caller.id },
      callGroup: call.id,
      signal: input.signal ?? call.signal,
    });
    call.count(outcome);
    // `agentTools` has no shadow mode; a shadow answer here would be a service bug, and the
    // agent is told JEV did not answer rather than handed an answer nothing acted on.
    if (outcome.kind === "shadow") {
      return { kind: "failed", callId: outcome.callId, reason: "contract", meta: outcome.meta };
    }
    return outcome;
  }

  function fileScope(caller: JevToolCaller, files: string[]): JevEgressScope {
    return { cwds: [], files, baseCwd: caller.cwd, agentIds: [caller.id] };
  }

  async function openScope(caller: JevToolCaller): Promise<JevFileScope | string> {
    const denials = readCallerDenials({
      toolsDeniedLabel: caller.labels[TOOLS_DENIED_LABEL],
      providerOptions: caller.providerOptions,
    });
    const opened = await JevFileScope.open({
      cwd: caller.cwd,
      homeDir,
      paseoHome: deps.paseoHome,
      platform,
      denials: denials.read,
      runGit: deps.runGit,
    });
    return opened.ok ? opened.scope : opened.reason;
  }

  /** D7 first, so an excluded file is never read, then the confined read. */
  async function loadFile(
    caller: JevToolCaller,
    scope: JevFileScope,
    ref: JevFileRef,
  ): Promise<JevFileContent | JevFileSkip> {
    const verdict = await jev.checkScope(fileScope(caller, [ref.absolutePath]));
    if (verdict === "excluded") return { path: ref.path, reason: UNAVAILABLE_TEXT.excluded };
    return scope.read(ref);
  }

  async function loadOneFile(
    call: ToolCall,
    requested: string,
  ): Promise<JevFileContent | { error: string }> {
    const scope = await openScope(call.caller);
    if (typeof scope === "string") return { error: scope };
    const pruned = await scope.prune([requested], 1);
    const skip = pruned.skipped[0];
    const ref = pruned.files[0];
    if (!ref) return { error: `${requested}: ${skip?.reason ?? "not found"}` };
    const loaded = await loadFile(call.caller, scope, ref);
    if ("reason" in loaded) return { error: `${loaded.path}: ${loaded.reason}` };
    const bytes = stateBytes({ path: loaded.path, content: loaded.content });
    if (bytes > STATE_MAX_BYTES) {
      return {
        error: `${loaded.path}: ${bytes.toLocaleString("en-US")} bytes as JEV state, over its ${STATE_MAX_BYTES.toLocaleString("en-US")}; use Read or grep`,
      };
    }
    return loaded;
  }

  async function run(
    tool: JevToolName,
    context: PaseoToolExecutionContext,
    work: (call: ToolCall) => Promise<ToolAnswer>,
  ): Promise<PaseoToolResult> {
    const startedAt = now();
    let caller: JevToolCaller | null = null;
    try {
      caller = options.readCallerAgent();
    } catch {
      caller = null;
    }
    if (!caller) {
      return toResult(refused("this agent is not loaded in the daemon; use Read or Bash"));
    }
    const call = new ToolCall(tool, caller, startedAt, context.signal);
    let answer: ToolAnswer;
    try {
      answer = await work(call);
    } catch (error) {
      log.warn({ err: error, tool, agentId: caller.id }, "jev tool threw");
      answer = refused("the JEV tool hit an error; use Read or Bash");
    }
    const result = toResult(answer);
    const resultChars = result.content.reduce((sum, part) => sum + (part.text?.length ?? 0), 0);
    try {
      deps.useLog?.append({
        v: 1,
        at: new Date(startedAt).toISOString(),
        agentId: caller.id,
        arm: "on",
        tool,
        outcome: answer.outcome,
        reason: answer.reason,
        jevCalls: call.jevCalls,
        jevAnswered: call.jevAnswered,
        jevUsd: call.jevUsd,
        jevInputTokens: call.jevInputTokens,
        resultChars,
        readTokensAvoided: call.readTokensAvoided,
        callerContextTokens: caller.contextTokens,
        cwd: caller.cwd,
        paths: call.paths,
        commandSha256: call.commandSha256,
        diffRisk: call.diffRisk,
        elapsedMs: now() - startedAt,
      });
    } catch (error) {
      log.warn({ err: error }, "jev tool-use record failed");
    }
    return result;
  }

  // -------------------------------------------------------------------------------------------
  // Feature 4: one file

  options.registerTool(
    "ask_jev_file_bool",
    {
      title: "Ask JEV yes or no about a file",
      description:
        "Yes or no about one file, without reading it into your context. Returns { path, answer, noul } where noul is the probability of yes, 0 to 1. Write the question against `content`, the file's text; `path` is in the state too. " +
        USE_READ,
      inputSchema: {
        path: z.string().min(1).describe("The file, relative to your working directory."),
        question: z.string().min(1).describe("A yes/no question about `content`."),
        yes: z.string().optional().describe("What counts as yes."),
        no: z.string().optional().describe("What counts as no."),
      },
    },
    (input: { path: string; question: string; yes?: string; no?: string }, context) =>
      run("ask_jev_file_bool", context, async (call) => {
        const inactive = inactiveOutcome();
        if (inactive) return fellBack(inactive, outcomeText(inactive));
        const file = await loadOneFile(call, input.path);
        if ("error" in file) return refused(file.error);
        const criteria =
          input.yes || input.no
            ? {
                ...(input.yes ? { true: input.yes } : {}),
                ...(input.no ? { false: input.no } : {}),
              }
            : undefined;
        const outcome = await decide(call, {
          state: { path: file.path, content: file.content },
          questions: { answer: noul(input.question, criteria) },
          scope: fileScope(call.caller, [file.absolutePath]),
        });
        if (unanswered(outcome)) return fellBack(outcome, outcomeText(outcome));
        const answer = outcome.answers["answer"];
        if (answer?.type !== "noul") return refused("JEV's answer was malformed; use Read");
        call.sent([file]);
        return ok({ path: file.path, answer: answer.noul > 0.5, noul: round3(answer.noul) });
      }),
  );

  options.registerTool(
    "ask_jev_file_choice",
    {
      title: "Ask JEV to pick an option about a file",
      description:
        'Pick one of your options about one file, without reading it. Returns { path, choice, confidence }; choice is always one of your keys, and an "other" option is added if you leave none. Up to 255 options. ' +
        USE_READ,
      inputSchema: {
        path: z.string().min(1).describe("The file, relative to your working directory."),
        question: z.string().min(1).describe("The question about `content`, the file's text."),
        options: z
          .record(z.string().min(1), z.string())
          .describe("Option key to a description of when it applies."),
        include_probabilities: z
          .boolean()
          .optional()
          .describe("Also return every option's probability."),
      },
    },
    (
      input: {
        path: string;
        question: string;
        options: Record<string, string>;
        include_probabilities?: boolean;
      },
      context,
    ) =>
      run("ask_jev_file_choice", context, async (call) => {
        const criteria: Record<string, string | null> = { ...input.options };
        if (!("other" in criteria) && !("none" in criteria) && !("none_of_the_above" in criteria)) {
          criteria["other"] = "None of the above";
        }
        const count = Object.keys(criteria).length;
        if (count < 2 || count > MAX_CHOICE_OPTIONS) {
          return refused(
            `options needs 1 to ${MAX_CHOICE_OPTIONS - 1} entries besides "other" (got ${Object.keys(input.options).length})`,
          );
        }
        const inactive = inactiveOutcome();
        if (inactive) return fellBack(inactive, outcomeText(inactive));
        const file = await loadOneFile(call, input.path);
        if ("error" in file) return refused(file.error);
        const outcome = await decide(call, {
          state: { path: file.path, content: file.content },
          questions: { answer: choice(input.question, criteria) },
          scope: fileScope(call.caller, [file.absolutePath]),
        });
        if (unanswered(outcome)) return fellBack(outcome, outcomeText(outcome));
        const answer = outcome.answers["answer"];
        if (answer?.type !== "choice") return refused("JEV's answer was malformed; use Read");
        call.sent([file]);
        const payload = {
          path: file.path,
          ...compactAnswer(answer, input.include_probabilities === true),
        };
        return ok(
          input.include_probabilities
            ? fitMap(payload, "probabilities", JEV_TOOL_RESULT_HARD_CAP)
            : payload,
        );
      }),
  );

  options.registerTool(
    "ask_jev_file_score",
    {
      title: "Ask JEV to place a file on a scale",
      description:
        "A position on a scale you define, about one file, without reading it. Levels are ordered low to high, 2 to 10 of them, each a described situation, not a degree. Returns { path, score, nearest, confidence }. " +
        USE_READ,
      inputSchema: {
        path: z.string().min(1).describe("The file, relative to your working directory."),
        question: z.string().min(1).describe("The question about `content`, the file's text."),
        levels: z
          .array(z.string().min(1))
          .min(2)
          .max(10)
          .describe("Situations from lowest to highest."),
      },
    },
    (input: { path: string; question: string; levels: string[] }, context) =>
      run("ask_jev_file_score", context, async (call) => {
        const inactive = inactiveOutcome();
        if (inactive) return fellBack(inactive, outcomeText(inactive));
        const file = await loadOneFile(call, input.path);
        if ("error" in file) return refused(file.error);
        const outcome = await decide(call, {
          state: { path: file.path, content: file.content },
          questions: { answer: score(input.question, input.levels) },
          scope: fileScope(call.caller, [file.absolutePath]),
        });
        if (unanswered(outcome)) return fellBack(outcome, outcomeText(outcome));
        const answer = outcome.answers["answer"];
        if (answer?.type !== "score") return refused("JEV's answer was malformed; use Read");
        call.sent([file]);
        const nearest = input.levels[Math.round(answer.score)] ?? "";
        return ok({
          path: file.path,
          score: round3(answer.score),
          nearest,
          confidence: round3(answer.confidence),
        });
      }),
  );

  // -------------------------------------------------------------------------------------------
  // Feature 5: many files

  options.registerTool(
    "ask_jev_files",
    {
      title: "Ask JEV the same questions of many files",
      description:
        'Ask the same typed questions of many files at once without reading any of them. Code expands globs and directories, drops ignored, binary, secret-shaped and oversized files, caps the list at 120, and makes one JEV call per file. Returns the top 20 { path, answers } ranked by your first question, the skipped files with reasons, and how many more there are; pass all or top for more. questions_json is a JSON object keyed by question id; each question is {"type":"noul","instructions":"Does `content` …?","criteria":{"true":"…","false":"…"}}, {"type":"choice","instructions":"Which … is `content`?","criteria":{"option":"when it applies","other":"none of the above"}} or {"type":"score","instructions":"How … is `content`?","criteria":["lowest situation","…","highest situation"]}. Ask everything you need in one block; it is one call per file either way. ' +
        USE_READ,
      inputSchema: {
        paths_or_globs: z
          .array(z.string().min(1))
          .min(1)
          .max(50)
          .describe("Files, directories or globs relative to your working directory."),
        questions_json: QuestionsJsonInput,
        recursive: z.boolean().optional().describe("Directories include everything below them."),
        top: z
          .number()
          .int()
          .min(1)
          .max(JEV_FILES_CAP)
          .optional()
          .describe("Results to return; default 20."),
        all: z.boolean().optional().describe("Return every result."),
        include_probabilities: z.boolean().optional().describe("Also return the probability maps."),
      },
    },
    (
      input: {
        paths_or_globs: string[];
        questions_json: unknown;
        recursive?: boolean;
        top?: number;
        all?: boolean;
        include_probabilities?: boolean;
      },
      context,
    ) =>
      run("ask_jev_files", context, async (call) => {
        const parsed = parseQuestionsJson(input.questions_json);
        if (!parsed.ok) return refused(parsed.reason);
        const inactive = inactiveOutcome();
        if (inactive) return fellBack(inactive, outcomeText(inactive));
        const scope = await openScope(call.caller);
        if (typeof scope === "string") return refused(scope);
        const expanded = await scope.expand(input.paths_or_globs, {
          recursive: input.recursive === true,
        });
        const pruned = await scope.prune(expanded.paths, JEV_FILES_CAP);
        const skipped: JevFileSkip[] = [...expanded.skipped, ...pruned.skipped];
        const results: Array<{ path: string; answers: Record<string, JevAnswer> }> = [];
        const deadline = AbortSignal.timeout(ASK_FILES_BUDGET_MS);
        const signal = call.signal ? AbortSignal.any([call.signal, deadline]) : deadline;
        const queue = [...pruned.files];
        let lastUnanswered: Exclude<JevOutcome, { kind: "answered" | "shadow" }> | null = null;
        const worker = async () => {
          for (let ref = queue.shift(); ref; ref = queue.shift()) {
            if (signal.aborted) {
              skipped.push({
                path: ref.path,
                reason: deadline.aborted ? "out of time" : "cancelled",
              });
              continue;
            }
            const loaded = await loadFile(call.caller, scope, ref);
            if ("reason" in loaded) {
              skipped.push(loaded);
              continue;
            }
            const state = { path: loaded.path, content: loaded.content };
            if (stateBytes(state) > STATE_MAX_BYTES) {
              skipped.push({ path: loaded.path, reason: "over JEV's 60,000-byte state as JSON" });
              continue;
            }
            const outcome = await decide(call, {
              state,
              questions: parsed.questions,
              scope: fileScope(call.caller, [loaded.absolutePath]),
              signal,
            });
            if (unanswered(outcome)) {
              lastUnanswered = outcome;
              const reason =
                outcome.kind === "failed" && outcome.reason === "aborted" && deadline.aborted
                  ? "out of time"
                  : outcomeText(outcome);
              skipped.push({ path: loaded.path, reason });
              continue;
            }
            call.sent([loaded]);
            results.push({ path: loaded.path, answers: outcome.answers });
          }
        };
        await Promise.all(Array.from({ length: ASK_FILES_CONCURRENCY }, worker));
        if (results.length === 0 && lastUnanswered) {
          const fallback = fellBack(lastUnanswered, outcomeText(lastUnanswered));
          return {
            ...fallback,
            payload: { error: fallback.payload, skipped: summarizeSkipped(skipped) },
          };
        }
        const ranked = rankResults(results, parsed.questions);
        const limit = input.all ? ranked.length : (input.top ?? ASK_FILES_DEFAULT_TOP);
        const withProbabilities = input.include_probabilities === true;
        const cap = input.all || withProbabilities ? JEV_TOOL_RESULT_HARD_CAP : JEV_TOOL_RESULT_CAP;
        const payload = fitFilesPayload({
          ranked,
          limit,
          withProbabilities,
          skipped,
          calls: call.jevCalls,
          cap,
        });
        const answer = ok(payload);
        if (results.length > 0 && call.jevAnswered < call.jevCalls) {
          return { ...answer, outcome: "partial", reason: "some files unanswered" };
        }
        if (results.length === 0) {
          return { ...answer, outcome: "refused", reason: "no file could be asked" };
        }
        return answer;
      }),
  );

  options.registerTool(
    "pick_first_file",
    {
      title: "Ask JEV which file to open first",
      description:
        "After ask_jev_files, choose which file to open first for a goal. The pick is always one of your paths, or null when nothing fits. Pass a one-line note per path if you have one. Use Read to open the file it picks.",
      inputSchema: {
        question: z.string().min(1).describe("The goal, e.g. which file handles token refresh."),
        candidates: z
          .array(z.object({ path: z.string().min(1), note: z.string().optional() }))
          .min(1)
          .max(PICK_FIRST_MAX_CANDIDATES),
        include_probabilities: z.boolean().optional(),
      },
    },
    (
      input: {
        question: string;
        candidates: Array<{ path: string; note?: string }>;
        include_probabilities?: boolean;
      },
      context,
    ) =>
      run("pick_first_file", context, async (call) => {
        const criteria: Record<string, string | null> = {};
        for (const candidate of input.candidates) {
          const key = candidate.path.trim();
          if (!key || key === "none" || key in criteria) continue;
          criteria[key] = candidate.note?.trim() ? candidate.note.trim() : null;
        }
        const paths = Object.keys(criteria);
        if (paths.length === 0) return refused("no usable candidate paths");
        criteria["none"] = "No file in the list fits";
        const inactive = inactiveOutcome();
        if (inactive) return fellBack(inactive, outcomeText(inactive));
        const outcome = await decide(call, {
          state: { question: input.question, files: paths },
          questions: { pick: choice(input.question, criteria) },
          scope: {
            cwds: [call.caller.cwd],
            files: paths,
            baseCwd: call.caller.cwd,
            agentIds: [call.caller.id],
          },
        });
        if (unanswered(outcome)) return fellBack(outcome, outcomeText(outcome));
        const answer = outcome.answers["pick"];
        if (answer?.type !== "choice") return refused("JEV's answer was malformed");
        const picked =
          answer.choice === "none" || answer.confidence < PICK_FIRST_FLOOR ? null : answer.choice;
        const payload: Record<string, unknown> = {
          path: picked,
          confidence: round3(answer.confidence),
        };
        if (input.include_probabilities) {
          payload["probabilities"] = roundedMap(answer.probabilities);
          return ok(fitMap(payload, "probabilities", JEV_TOOL_RESULT_HARD_CAP));
        }
        return ok(payload);
      }),
  );

  // -------------------------------------------------------------------------------------------
  // Feature 6a: ask_jev

  options.registerTool(
    "ask_jev",
    {
      title: "Ask JEV typed questions about a situation",
      description: ASK_JEV_DESCRIPTION,
      inputSchema: {
        questions_json: QuestionsJsonInput,
        state: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .optional()
          .describe("What only you can say, up to 8 KB. Not file contents or command output."),
        paths: z
          .array(z.string().min(1))
          .max(50)
          .optional()
          .describe("Files for code to read into files[path]; up to 20."),
        command: z
          .string()
          .min(1)
          .optional()
          .describe(
            "A command for code to run in your working directory; its result goes in output.",
          ),
        include_probabilities: z.boolean().optional(),
      },
    },
    (input: AskJevInput, context: PaseoToolExecutionContext) =>
      run("ask_jev", context, (call) => askJev(call, input)),
  );

  async function askJev(call: ToolCall, input: AskJevInput): Promise<ToolAnswer> {
    const parsed = parseQuestionsJson(input.questions_json);
    if (!parsed.ok) return refused(parsed.reason);
    const own = ownState(input.state);
    if ("error" in own) return refused(own.error);
    const command = input.command?.trim() || null;
    if (Object.keys(own.base).length === 0 && !input.paths?.length && !command) {
      return refused("ask_jev: nothing to judge. Pass state, paths or command");
    }
    const inactive = inactiveOutcome();
    if (inactive) return fellBack(inactive, outcomeText(inactive));
    const assembled = await assembleAskJev(call, own.base, input.paths, command);
    if ("isError" in assembled) return assembled;
    const { files, output } = assembled;
    const outcome = await decide(call, {
      state: assembled.state,
      questions: parsed.questions,
      scope: {
        cwds: command ? [call.caller.cwd] : [],
        files: files.sent.map((file) => file.absolutePath),
        baseCwd: call.caller.cwd,
        agentIds: [call.caller.id],
      },
    });
    if (unanswered(outcome)) return fellBack(outcome, outcomeText(outcome));
    call.sent(files.sent);
    if (output) call.readTokensAvoided += estimateReadTokens(`${output.stdout}${output.stderr}`);
    return ok(
      askJevPayload({
        answers: outcome.answers,
        meta: outcome.meta,
        ownFields: Object.keys(own.base),
        files: Object.keys(files.contents),
        output,
        skipped: files.skipped,
        withProbabilities: input.include_probabilities === true,
      }),
    );
  }

  /**
   * One state from the agent's own fields, `files` and `output`, in that order (reference level
   * 10). Nothing is cut: over 60 KB the call is refused with a split that fits.
   */
  async function assembleAskJev(
    call: ToolCall,
    base: Record<string, unknown>,
    paths: string[] | undefined,
    command: string | null,
  ): Promise<
    | { state: Record<string, unknown>; files: AskFiles; output: JevCommandOutput | null }
    | ToolAnswer
  > {
    const parts: StatePart[] = [];
    if (Object.keys(base).length > 0) {
      parts.push({ name: "your state", bytes: stateBytes(base), kind: "own" });
    }
    const files = paths?.length ? await askJevFiles(call, paths) : EMPTY_ASK_FILES;
    if ("isError" in files) return files;
    parts.push(...files.parts);
    let output: JevCommandOutput | null = null;
    if (command) {
      const ran = await askJevCommand(call, command);
      if (ran.kind === "refused") return refused(ran.reason);
      output = ran.output;
      parts.push({
        name: `output of \`${truncate(command, 80)}\``,
        bytes: stateBytes(output),
        kind: "output",
      });
    }
    if (parts.length === 0) {
      const reasons = files.skipped.map((skip) => `${skip.path}: ${skip.reason}`).join("; ");
      return refused(`ask_jev: nothing left to judge; every path was skipped (${reasons})`);
    }
    const total = parts.reduce((sum, part) => sum + part.bytes, 0);
    if (total > STATE_MAX_BYTES) return refused(overflowMessage(parts, STATE_MAX_BYTES));
    const state: Record<string, unknown> = { ...base };
    if (files.sent.length > 0) state["files"] = files.contents;
    if (output) state["output"] = output;
    return { state, files, output };
  }

  /** Up to 20 files by the file tools' rules; more is a job for `ask_jev_files`. */
  async function askJevFiles(call: ToolCall, paths: string[]): Promise<AskFiles | ToolAnswer> {
    const scope = await openScope(call.caller);
    if (typeof scope === "string") return refused(scope);
    const expanded = await scope.expand(paths, { recursive: true });
    const pruned = await scope.prune(expanded.paths, ASK_JEV_MAX_FILES + 1);
    if (pruned.files.length > ASK_JEV_MAX_FILES) {
      return refused(
        `ask_jev: paths expanded to more than ${ASK_JEV_MAX_FILES} files. This tool judges one situation in one call. For many files use ask_jev_files, or narrow the paths`,
      );
    }
    const result: AskFiles = {
      contents: {},
      sent: [],
      parts: [],
      skipped: [...expanded.skipped, ...pruned.skipped],
    };
    for (const ref of pruned.files) {
      const loaded = await loadFile(call.caller, scope, ref);
      if ("reason" in loaded) {
        result.skipped.push(loaded);
        continue;
      }
      result.contents[loaded.path] = loaded.content;
      result.sent.push(loaded);
      result.parts.push({ name: loaded.path, bytes: stateBytes(loaded.content), kind: "file" });
    }
    return result;
  }

  function askJevCommand(call: ToolCall, command: string) {
    const denials = readCallerDenials({
      toolsDeniedLabel: call.caller.labels[TOOLS_DENIED_LABEL],
      providerOptions: call.caller.providerOptions,
    });
    call.commandSha256 = createHash("sha256").update(command, "utf8").digest("hex");
    return runJevCommand({
      command,
      cwd: call.caller.cwd,
      gate: deps.commandGate,
      bashDenied: denials.bashDenied,
      platform,
      baseEnv: deps.commandBaseEnv,
      signal: call.signal,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Feature 6b: diff risk, add-only

  options.registerTool(
    "ask_jev_diff_risk",
    {
      title: "Score a branch's diff for review risk",
      description:
        "Score a branch's diff for risk before merge. Code runs git diff and git log itself; you pass only the base branch. Returns { risk 0..1, needs_full_review, forced_by, parts, reason }. It can only add review: needs_full_review false never means skip the review your process requires. Any failure, a large diff or a sensitive path answers needs_full_review: true. Use Read when you need the code itself.",
      inputSchema: {
        base: z
          .string()
          .min(1)
          .optional()
          .describe("Branch or commit to diff against; defaults to the upstream or origin/HEAD."),
      },
    },
    (input: { base?: string }, context) =>
      run("ask_jev_diff_risk", context, (call) => diffRisk(call, input)),
  );

  async function diffRisk(call: ToolCall, input: { base?: string }): Promise<ToolAnswer> {
    const finish = (result: DiffRiskResult, callId: string | null): ToolAnswer => {
      call.diffRisk = {
        risk: result.risk,
        needsFullReview: result.needs_full_review,
        forcedBy: result.forced_by,
      };
      if (callId) {
        jev.decisions.record({
          agentId: call.caller.id,
          callId,
          feature: "agentTools",
          question: "ask_jev_diff_risk: does this branch need a full review?",
          verdict: result.risk === null ? "no score" : `risk ${result.risk}`,
          confidence: null,
          action: result.needs_full_review
            ? "full review added"
            : "no review added; the process's own review still applies",
          applied: true,
        });
      }
      return ok(result);
    };
    const failed = (reason: string): ToolAnswer =>
      finish({ ...scoreDiffRisk({ answers: null, forcedBy: [reason] }), diff: null }, null);

    const scope = await openScope(call.caller);
    if (typeof scope === "string") return failed(scope);
    const collected = await collectDiff({
      cwd: scope.realCwd,
      base: input.base,
      runGit: deps.runGit,
    });
    if (!collected.ok) return failed(`git: ${collected.reason}`);
    const diff = collected.diff;
    const stats = {
      base: diff.base,
      files: diff.paths.length,
      lines: diff.lines,
      bytes: diff.diffBytes,
    };
    if (diff.paths.length === 0) {
      return finish(
        {
          risk: null,
          needs_full_review: false,
          forced_by: [],
          parts: null,
          reason: `No changes between ${diff.base} and HEAD.`,
          diff: stats,
        },
        null,
      );
    }
    const forcedBy = deterministicTriggers(diff);
    const ruled = diff.paths.find(
      (entry) => scope.deniedReason(path.join(diff.top, entry.path)) !== null,
    );
    let unansweredReason: string | undefined;
    let answers: Record<string, JevAnswer> | null = null;
    let callId: string | null = null;
    if (diff.diffOverCap) {
      unansweredReason = "the diff is over 60 KB, so it was not sent";
    } else if (ruled) {
      unansweredReason = `${ruled.path} is a file the JEV tools never send, so the diff was not sent`;
    } else {
      const inactive = inactiveOutcome();
      if (inactive) {
        unansweredReason = outcomeText(inactive);
      } else {
        const outcome = await decide(call, {
          state: { diff: diff.diff, commit_message: diff.commitMessage },
          questions: DIFF_RISK_QUESTIONS,
          scope: { cwds: [diff.top], agentIds: [call.caller.id] },
        });
        callId = outcome.callId;
        if (unanswered(outcome)) unansweredReason = outcomeText(outcome);
        else answers = outcome.answers;
      }
    }
    return finish(
      { ...scoreDiffRisk({ answers, forcedBy, unansweredReason }), diff: stats },
      callId,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers

interface StatePart {
  name: string;
  bytes: number;
  kind: "own" | "file" | "output";
}

interface AskJevInput {
  questions_json: unknown;
  state?: string | Record<string, unknown>;
  paths?: string[];
  command?: string;
  include_probabilities?: boolean;
}

interface AskFiles {
  contents: Record<string, string>;
  sent: JevFileContent[];
  parts: StatePart[];
  skipped: JevFileSkip[];
}

const EMPTY_ASK_FILES: AskFiles = { contents: {}, sent: [], parts: [], skipped: [] };

function askJevPayload(input: {
  answers: Record<string, JevAnswer>;
  meta: { redactions: number; model: string };
  ownFields: string[];
  files: string[];
  output: JevCommandOutput | null;
  skipped: JevFileSkip[];
  withProbabilities: boolean;
}): Record<string, unknown> {
  const { output } = input;
  const payload: Record<string, unknown> = {
    answers: compactAnswers(input.answers, input.withProbabilities),
    state_summary: {
      own_fields: input.ownFields,
      files: input.files,
      output: output
        ? `${truncate(output.command, 120)}, exit ${output.exit_code ?? "none"}, ${stateBytes(output).toLocaleString("en-US")} bytes`
        : null,
      ...(input.skipped.length > 0 ? { skipped: summarizeSkipped(input.skipped) } : {}),
    },
    redacted: input.meta.redactions,
    model: input.meta.model,
  };
  if (input.withProbabilities && JSON.stringify(payload).length > JEV_TOOL_RESULT_HARD_CAP) {
    payload["answers"] = compactAnswers(input.answers, false);
    payload["note"] = "probabilities left out: over the output cap";
  }
  return payload;
}

function stateBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The agent's own state: a JSON string becomes an object; text becomes `{ text }`. */
function ownState(
  raw: string | Record<string, unknown> | undefined,
): { base: Record<string, unknown> } | { error: string } {
  const base = ownStateBase(raw);
  for (const reserved of ["files", "output"]) {
    if (reserved in base) {
      return {
        error: `ask_jev: your state has a \`${reserved}\` field, which code fills; rename it`,
      };
    }
  }
  const bytes = stateBytes(base);
  if (bytes > OWN_STATE_MAX_BYTES) {
    return {
      error: `ask_jev: your state is ${bytes.toLocaleString("en-US")} bytes; the limit for your own state is ${OWN_STATE_MAX_BYTES.toLocaleString("en-US")}. Do not paste file contents or command output; pass paths or command instead and code fetches them`,
    };
  }
  return { base };
}

function ownStateBase(raw: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  if (typeof raw !== "string") return { ...raw };
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const looksJson =
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));
  if (!looksJson) return { text: raw };
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { text: raw };
  }
  if (Array.isArray(value)) return { items: value };
  if (typeof value === "object" && value !== null) return { ...(value as Record<string, unknown>) };
  return { text: raw };
}

/** Greedy first fit, largest first, so the refusal can say how to split (reference level 10). */
function suggestSplit(parts: StatePart[], budget: number): StatePart[][] {
  const bins: Array<{ total: number; items: StatePart[] }> = [];
  for (const part of [...parts].sort((a, b) => b.bytes - a.bytes)) {
    const bin = bins.find((candidate) => candidate.total + part.bytes <= budget);
    if (bin) {
      bin.items.push(part);
      bin.total += part.bytes;
    } else {
      bins.push({ total: part.bytes, items: [part] });
    }
  }
  return bins.map((bin) => bin.items);
}

function formatBytes(bytes: number): string {
  return `${bytes.toLocaleString("en-US")} bytes`;
}

function describeParts(parts: StatePart[]): string {
  const files = parts.filter((part) => part.kind === "file").map((part) => part.name);
  const bits: string[] = [];
  if (parts.some((part) => part.kind === "own")) bits.push("your state");
  if (files.length > 0) bits.push(`paths [${files.join(", ")}]`);
  if (parts.some((part) => part.kind === "output")) bits.push("the command");
  return `${bits.join(" + ")} (${formatBytes(parts.reduce((sum, part) => sum + part.bytes, 0))})`;
}

export function overflowMessage(parts: StatePart[], budget: number): string {
  const total = parts.reduce((sum, part) => sum + part.bytes, 0);
  const oversize = parts.filter((part) => part.bytes > budget);
  const lines = [
    `ask_jev: the state is ${formatBytes(total)}, the limit per call is ${formatBytes(budget)}.`,
    `Parts: ${[...parts]
      .sort((a, b) => b.bytes - a.bytes)
      .map((part) => `${part.name} ${formatBytes(part.bytes)}`)
      .join(", ")}.`,
  ];
  if (oversize.length > 0) {
    lines.push(
      `Too large for any single call: ${oversize.map((part) => part.name).join(", ")}. Narrow it (a smaller file, a command with less output) or leave it out.`,
    );
  } else {
    const groups = suggestSplit(parts, budget);
    if (groups.length > 1) {
      lines.push(
        `Split into ${groups.length} calls with the same questions_json: ${groups
          .map((group, index) => `call ${index + 1}: ${describeParts(group)}`)
          .join("; ")}.`,
      );
    }
  }
  return lines.join(" ");
}

/** Ranked by the first question: yes-probability, then option order and confidence, then score. */
export function rankResults(
  results: Array<{ path: string; answers: Record<string, JevAnswer> }>,
  questions: JevQuestions,
): Array<{ path: string; answers: Record<string, JevAnswer> }> {
  const firstId = Object.keys(questions)[0];
  const first = firstId ? questions[firstId] : undefined;
  const optionOrder = first?.type === "choice" ? Object.keys(first.criteria) : [];
  const key = (answers: Record<string, JevAnswer>): [number, number] => {
    const answer = firstId ? answers[firstId] : undefined;
    if (!answer) return [Number.MAX_SAFE_INTEGER, 0];
    if (answer.type === "noul") return [0, answer.noul];
    if (answer.type === "score") return [0, answer.score];
    const index = optionOrder.indexOf(answer.choice);
    return [index < 0 ? optionOrder.length : index, answer.confidence];
  };
  return [...results].sort((a, b) => {
    const [groupA, valueA] = key(a.answers);
    const [groupB, valueB] = key(b.answers);
    if (groupA !== groupB) return groupA - groupB;
    if (valueA !== valueB) return valueB - valueA;
    return a.path.localeCompare(b.path);
  });
}

function normalizeReason(reason: string): string {
  return reason.replace(/\s*\([^)]*\)/g, "").trim();
}

/** At most 20 skipped files named; past that, counts by reason. */
function summarizeSkipped(skipped: JevFileSkip[]): Record<string, unknown> | JevFileSkip[] {
  if (skipped.length <= SKIPPED_SHOWN) return skipped;
  const byReason: Record<string, number> = {};
  for (const skip of skipped) {
    const reason = normalizeReason(skip.reason);
    byReason[reason] = (byReason[reason] ?? 0) + 1;
  }
  return { shown: skipped.slice(0, SKIPPED_SHOWN), total: skipped.length, by_reason: byReason };
}

/** The ranked results that fit the cap; `more` counts the rest, so the agent can ask with top. */
function fitFilesPayload(input: {
  ranked: Array<{ path: string; answers: Record<string, JevAnswer> }>;
  limit: number;
  withProbabilities: boolean;
  skipped: JevFileSkip[];
  calls: number;
  cap: number;
}): Record<string, unknown> {
  const build = (count: number) => ({
    results: input.ranked.slice(0, count).map((result) => ({
      path: result.path,
      answers: compactAnswers(result.answers, input.withProbabilities),
    })),
    skipped: summarizeSkipped(input.skipped),
    more: input.ranked.length - count,
    calls: input.calls,
  });
  let count = Math.min(input.limit, input.ranked.length);
  let payload = build(count);
  while (count > 0 && JSON.stringify(payload).length > input.cap) {
    count = Math.max(0, Math.min(count - 1, Math.floor(count * 0.8)));
    payload = build(count);
  }
  if (count < Math.min(input.limit, input.ranked.length)) {
    return {
      ...payload,
      note: `cut to ${count} results to fit the output cap; ask with top or narrow the pattern`,
    };
  }
  return payload;
}

/** Drops the smallest entries of a probability map until the payload fits. */
function fitMap(
  payload: Record<string, unknown>,
  field: string,
  cap: number,
): Record<string, unknown> {
  if (JSON.stringify(payload).length <= cap) return payload;
  const map = payload[field] as Record<string, number>;
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  while (
    entries.length > 0 &&
    JSON.stringify({ ...payload, [field]: Object.fromEntries(entries) }).length > cap
  ) {
    entries.pop();
  }
  return {
    ...payload,
    [field]: Object.fromEntries(entries),
    note: "smallest probabilities left out to fit the output cap",
  };
}

const TEST_FAILURE_RECIPE = `{
  "failure_kind": {
    "type": "choice",
    "instructions": "What kind of failure does \`output\` show?",
    "criteria": {
      "bug_in_code": "The code under test does the wrong thing: an assertion about real behaviour fails",
      "wrong_test": "The test expects the wrong thing, or is out of date with an intended change",
      "environment": "A missing tool, dependency, port, file or permission; the code never really ran",
      "flaky": "Timing, ordering or the network makes it pass and fail without a code change",
      "other": "None of these"
    }
  }
}`;

export const ASK_JEV_DESCRIPTION = [
  'Ask JEV typed questions about one situation: files, a command\'s output, your own notes, or any mix. It answers in about half a second for a fraction of a cent, and each answer is a number you can branch on, not prose. Pass paths and code reads the files into files["path"]. Pass command and code runs it in your working directory and puts the result in output {command, exit_code, stdout, stderr}; the command goes through the same safety gate as Bash. Use state only for what only you can say, not for pasting content. One call judges one situation: up to 20 files and about 60 KB. Write questions against files["path"], output or your own field names; always give a choice an "other" option; describe situations, not degrees. Good uses: run the tests through command and classify the failure before choosing a fix; decide whether a request is clear enough to plan. Not for exact lookups, counting or math. ' +
    USE_READ,
  "",
  "Test-failure recipe for questions_json:",
  TEST_FAILURE_RECIPE,
].join("\n");
