import type { JevQuestion, JevStatus } from "@getpaseo/protocol/jev/rpc-schemas";
import {
  mapAskJevClientFailure,
  mapAskJevPayload,
  type AskJevPayload,
  type AskJevResultView,
} from "./ask-jev-result";

/**
 * The Ask JEV form (docs/jev.md, "Feature 15: Ask JEV"), shaped like the schedule form
 * (docs/forms.md): a plain model, constructed once per mount, with late data applied as explicit
 * inputs. The screen renders `getState()` and dispatches intent.
 */

export type AskJevAnswerType = "noul" | "choice" | "score";
export type AskJevScalePreset = "low-high" | "one-to-five" | "custom";

export interface AskJevHost {
  serverId: string;
  label: string;
}

export interface AskJevDisplay {
  label: string;
}

export interface AskJevOption {
  id: string;
  label: string;
  description: string;
}

export interface AskJevLevel {
  id: string;
  label: string;
}

/**
 * Whether the selected host can take a question now. Derived from live host data by
 * `resolveAskJevAvailability` and applied with `applyAvailability`.
 */
export type AskJevAvailability =
  | { kind: "no-host" }
  | { kind: "connecting" }
  | { kind: "update-host" }
  | { kind: "checking" }
  | { kind: "not-configured" }
  | { kind: "off"; reason: string }
  | { kind: "budget-spent"; capUsd: number; resetsAt: string }
  /** `fake` when the host runs `PASEO_JEV_BACKEND=fake`: answers are simulated and nothing leaves. */
  | { kind: "ready"; fake: boolean };

export interface AskJevRequest {
  context: string;
  question: JevQuestion;
  agentId?: string;
  deadlineMs: number;
}

export interface AskJevSubmission {
  token: number;
  serverId: string;
  request: AskJevRequest;
}

export type AskJevRun =
  | { status: "idle" }
  | { status: "pending"; token: number }
  | { status: "settled"; result: AskJevResultView }
  | { status: "cancelled" };

export interface AskJevFieldErrors {
  context: string | null;
  question: string | null;
  options: string | null;
  levels: string | null;
}

export interface AskJevFormState {
  hosts: AskJevHost[];
  selectedServerId: string | null;
  hostDisplay: AskJevDisplay | null;
  availability: AskJevAvailability;
  context: string;
  contextBytes: number;
  agentId: string | null;
  agentDisplay: AskJevDisplay | null;
  question: string;
  answerType: AskJevAnswerType;
  describeOptions: boolean;
  yesMeans: string;
  noMeans: string;
  options: AskJevOption[];
  scalePreset: AskJevScalePreset;
  levels: AskJevLevel[];
  run: AskJevRun;
  /** Set by the first submit that failed validation; field errors show from then on. */
  attemptedSubmit: boolean;
  errors: AskJevFieldErrors;
  canAddOption: boolean;
  canAddLevel: boolean;
  canSubmit: boolean;
}

export interface AskJevFormSnapshot {
  hosts: readonly AskJevHost[];
  defaults: { serverId: string | null };
}

export interface AskJevFormModel {
  getState: () => AskJevFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  applyHosts: (hosts: readonly AskJevHost[]) => void;
  applyAvailability: (serverId: string, availability: AskJevAvailability) => void;
  setHost: (serverId: string, display: AskJevDisplay) => void;
  setContext: (value: string) => void;
  setAgent: (agentId: string | null, display: AskJevDisplay | null) => void;
  setQuestion: (value: string) => void;
  setAnswerType: (value: AskJevAnswerType) => void;
  setDescribeOptions: (value: boolean) => void;
  setYesMeans: (value: string) => void;
  setNoMeans: (value: string) => void;
  setOptionLabel: (id: string, value: string) => void;
  setOptionDescription: (id: string, value: string) => void;
  addOption: () => void;
  removeOption: (id: string) => void;
  setScalePreset: (value: AskJevScalePreset) => void;
  setLevelLabel: (id: string, value: string) => void;
  addLevel: () => void;
  removeLevel: (id: string) => void;
  /** Null when the form cannot be sent; field errors show from then on. */
  submit: () => AskJevSubmission | null;
  settle: (token: number, payload: AskJevPayload) => void;
  fail: (token: number, error: unknown) => void;
  cancel: () => void;
}

/** The daemon's state cap (`JEV_MAX_STATE_BYTES`). The context is most of the state. */
export const ASK_JEV_MAX_CONTEXT_BYTES = 60_000;
/** What the app asks the host to wait; the daemon clamps it to `agents.jev.askJev.timeoutMs`. */
export const ASK_JEV_DEADLINE_MS = 15_000;
export const ASK_JEV_MIN_OPTIONS = 2;
export const ASK_JEV_MAX_OPTIONS = 20;
/** JEV's own score limits. */
export const ASK_JEV_MIN_LEVELS = 2;
export const ASK_JEV_MAX_LEVELS = 10;

export const ASK_JEV_SCALE_PRESETS: Record<Exclude<AskJevScalePreset, "custom">, string[]> = {
  "low-high": ["Low", "Medium", "High"],
  "one-to-five": ["1", "2", "3", "4", "5"],
};

/** UTF-8 length without `TextEncoder`, which Hermes builds do not all ship. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      // A surrogate pair is one 4-byte code point.
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** From the host's connection, its capability and `jev.status`; one place decides. */
export function resolveAskJevAvailability(input: {
  hasHost: boolean;
  connected: boolean;
  supportsAsk: boolean;
  status: JevStatus | null | undefined;
  statusFailed: boolean;
}): AskJevAvailability {
  if (!input.hasHost) return { kind: "no-host" };
  if (!input.connected) return { kind: "connecting" };
  if (!input.supportsAsk) return { kind: "update-host" };
  const status = input.status;
  if (!status) {
    // A status that could not be read does not stop a question: its answer names the reason.
    return input.statusFailed ? { kind: "ready", fake: false } : { kind: "checking" };
  }
  if (status.reason === "no-key") return { kind: "not-configured" };
  if (status.reason) return { kind: "off", reason: status.reason };
  if (status.features["askJev"]?.enabled === false) {
    return { kind: "off", reason: "feature-disabled" };
  }
  const lane = status.lanes["interactive"];
  if (lane?.exhausted) {
    return { kind: "budget-spent", capUsd: lane.maxUsdPerDay, resetsAt: lane.resetsAt };
  }
  return { kind: "ready", fake: status.provider === "fake" };
}

let nextRowId = 0;
function rowId(prefix: string): string {
  nextRowId += 1;
  return `${prefix}-${nextRowId}`;
}

function emptyOptions(): AskJevOption[] {
  return [
    { id: rowId("option"), label: "", description: "" },
    { id: rowId("option"), label: "", description: "" },
  ];
}

function levelsFor(labels: readonly string[]): AskJevLevel[] {
  return labels.map((label) => ({ id: rowId("level"), label }));
}

function presetFor(levels: readonly AskJevLevel[]): AskJevScalePreset {
  const labels = levels.map((level) => level.label);
  for (const [preset, presetLabels] of Object.entries(ASK_JEV_SCALE_PRESETS)) {
    if (
      presetLabels.length === labels.length &&
      presetLabels.every((label, index) => label === labels[index])
    ) {
      return preset as AskJevScalePreset;
    }
  }
  return "custom";
}

function filledOptions(options: readonly AskJevOption[]): AskJevOption[] {
  return options.filter((option) => option.label.trim().length > 0);
}

function optionsError(options: readonly AskJevOption[]): string | null {
  const filled = filledOptions(options);
  if (filled.length < ASK_JEV_MIN_OPTIONS) return "Add at least two options";
  const labels = filled.map((option) => option.label.trim());
  if (new Set(labels).size !== labels.length) return "Each option needs a different name";
  return null;
}

function levelsError(levels: readonly AskJevLevel[]): string | null {
  if (levels.length < ASK_JEV_MIN_LEVELS) return "A scale needs at least two levels";
  if (levels.some((level) => level.label.trim().length === 0)) return "Name every level";
  return null;
}

function computeErrors(state: AskJevFormState): AskJevFieldErrors {
  // The size cap is a hard limit, so it shows while typing; the rest wait for a submit.
  const context =
    state.contextBytes > ASK_JEV_MAX_CONTEXT_BYTES
      ? `Context is over ${Math.floor(ASK_JEV_MAX_CONTEXT_BYTES / 1000)} KB`
      : null;
  if (!state.attemptedSubmit) {
    return { context, question: null, options: null, levels: null };
  }
  return {
    context,
    question: state.question.trim().length === 0 ? "Enter a question" : null,
    options: state.answerType === "choice" ? optionsError(state.options) : null,
    levels: state.answerType === "score" ? levelsError(state.levels) : null,
  };
}

function isValid(state: AskJevFormState): boolean {
  if (state.contextBytes > ASK_JEV_MAX_CONTEXT_BYTES) return false;
  if (state.question.trim().length === 0) return false;
  if (state.answerType === "choice" && optionsError(state.options)) return false;
  if (state.answerType === "score" && levelsError(state.levels)) return false;
  return true;
}

function derive(state: AskJevFormState): AskJevFormState {
  const withBytes = { ...state, contextBytes: utf8ByteLength(state.context) };
  return {
    ...withBytes,
    errors: computeErrors(withBytes),
    canAddOption: withBytes.options.length < ASK_JEV_MAX_OPTIONS,
    canAddLevel: withBytes.levels.length < ASK_JEV_MAX_LEVELS,
    // A form with errors stays pressable, so pressing Ask is what reveals them.
    canSubmit:
      withBytes.selectedServerId !== null &&
      withBytes.availability.kind === "ready" &&
      withBytes.run.status !== "pending",
  };
}

function trimmedOrUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** The typed question JEV gets. The person's question is the instructions. */
export function buildAskJevQuestion(state: AskJevFormState): JevQuestion {
  const instructions = state.question.trim();
  switch (state.answerType) {
    case "noul": {
      const yes = state.describeOptions ? trimmedOrUndefined(state.yesMeans) : undefined;
      const no = state.describeOptions ? trimmedOrUndefined(state.noMeans) : undefined;
      if (!yes && !no) return { type: "noul", instructions };
      return {
        type: "noul",
        instructions,
        criteria: { ...(yes ? { true: yes } : {}), ...(no ? { false: no } : {}) },
      };
    }
    case "choice":
      return {
        type: "choice",
        instructions,
        criteria: Object.fromEntries(
          filledOptions(state.options).map((option) => [
            option.label.trim(),
            state.describeOptions ? (trimmedOrUndefined(option.description) ?? null) : null,
          ]),
        ),
      };
    case "score":
      return {
        type: "score",
        instructions,
        criteria: state.levels.map((level) => level.label.trim()),
      };
  }
}

function hostDisplayFor(hosts: readonly AskJevHost[], serverId: string | null) {
  const host = hosts.find((candidate) => candidate.serverId === serverId);
  return host ? { label: host.label } : null;
}

function initialState(snapshot: AskJevFormSnapshot): AskJevFormState {
  const hosts = [...snapshot.hosts];
  const serverId =
    snapshot.defaults.serverId && hosts.some((host) => host.serverId === snapshot.defaults.serverId)
      ? snapshot.defaults.serverId
      : (hosts[0]?.serverId ?? null);
  return derive({
    hosts,
    selectedServerId: serverId,
    hostDisplay: hostDisplayFor(hosts, serverId),
    availability: serverId ? { kind: "checking" } : { kind: "no-host" },
    context: "",
    contextBytes: 0,
    agentId: null,
    agentDisplay: null,
    question: "",
    answerType: "noul",
    describeOptions: false,
    yesMeans: "",
    noMeans: "",
    options: emptyOptions(),
    scalePreset: "low-high",
    levels: levelsFor(ASK_JEV_SCALE_PRESETS["low-high"]),
    run: { status: "idle" },
    attemptedSubmit: false,
    errors: { context: null, question: null, options: null, levels: null },
    canAddOption: true,
    canAddLevel: true,
    canSubmit: false,
  });
}

export function openAskJevForm(snapshot: AskJevFormSnapshot): AskJevFormModel {
  const listeners = new Set<() => void>();
  let closed = false;
  let state = initialState(snapshot);
  let nextToken = 0;
  /** The question as it was sent, so a settled answer maps onto the options that were asked. */
  let askedQuestion: JevQuestion | null = null;

  function publish(next: AskJevFormState): void {
    if (closed) return;
    state = derive(next);
    for (const listener of listeners) listener();
  }

  function update(patch: Partial<AskJevFormState>): void {
    publish({ ...state, ...patch });
  }

  function updateOptions(map: (option: AskJevOption) => AskJevOption): void {
    update({ options: state.options.map(map) });
  }

  return {
    getState: () => state,
    subscribe(listener) {
      if (closed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      listeners.clear();
    },
    applyHosts(nextHosts) {
      if (closed) return;
      const hosts = [...nextHosts];
      const stillThere = hosts.some((host) => host.serverId === state.selectedServerId);
      const serverId = stillThere ? state.selectedServerId : (hosts[0]?.serverId ?? null);
      if (serverId === state.selectedServerId) {
        publish({ ...state, hosts });
        return;
      }
      // The selected host vanished: the next one takes over, with its own label and agents.
      publish({
        ...state,
        hosts,
        selectedServerId: serverId,
        hostDisplay: hostDisplayFor(hosts, serverId),
        availability: serverId ? { kind: "checking" } : { kind: "no-host" },
        agentId: null,
        agentDisplay: null,
      });
    },
    applyAvailability(serverId, availability) {
      if (serverId !== state.selectedServerId) return;
      if (JSON.stringify(availability) === JSON.stringify(state.availability)) return;
      update({ availability });
    },
    setHost(serverId, display) {
      if (serverId === state.selectedServerId) return;
      update({
        selectedServerId: serverId,
        hostDisplay: display,
        availability: { kind: "checking" },
        // Agents belong to a host.
        agentId: null,
        agentDisplay: null,
        run: { status: "idle" },
      });
    },
    setContext: (value) => update({ context: value }),
    setAgent: (agentId, display) => update({ agentId, agentDisplay: agentId ? display : null }),
    setQuestion: (value) => update({ question: value }),
    setAnswerType: (value) => update({ answerType: value }),
    setDescribeOptions: (value) => update({ describeOptions: value }),
    setYesMeans: (value) => update({ yesMeans: value }),
    setNoMeans: (value) => update({ noMeans: value }),
    setOptionLabel: (id, value) =>
      updateOptions((option) => (option.id === id ? { ...option, label: value } : option)),
    setOptionDescription: (id, value) =>
      updateOptions((option) => (option.id === id ? { ...option, description: value } : option)),
    addOption() {
      if (!state.canAddOption) return;
      update({ options: [...state.options, { id: rowId("option"), label: "", description: "" }] });
    },
    removeOption(id) {
      if (state.options.length <= ASK_JEV_MIN_OPTIONS) return;
      update({ options: state.options.filter((option) => option.id !== id) });
    },
    setScalePreset(value) {
      if (value === "custom") {
        update({ scalePreset: "custom" });
        return;
      }
      // New rows, so the inputs remount with the preset's text.
      update({ scalePreset: value, levels: levelsFor(ASK_JEV_SCALE_PRESETS[value]) });
    },
    setLevelLabel(id, value) {
      const levels = state.levels.map((level) =>
        level.id === id ? { ...level, label: value } : level,
      );
      update({ levels, scalePreset: presetFor(levels) });
    },
    addLevel() {
      if (!state.canAddLevel) return;
      const levels = [...state.levels, { id: rowId("level"), label: "" }];
      update({ levels, scalePreset: presetFor(levels) });
    },
    removeLevel(id) {
      if (state.levels.length <= ASK_JEV_MIN_LEVELS) return;
      const levels = state.levels.filter((level) => level.id !== id);
      update({ levels, scalePreset: presetFor(levels) });
    },
    submit() {
      if (closed || !state.canSubmit || !state.selectedServerId) return null;
      if (!isValid(state)) {
        update({ attemptedSubmit: true });
        return null;
      }
      nextToken += 1;
      const token = nextToken;
      const question = buildAskJevQuestion(state);
      askedQuestion = question;
      update({ attemptedSubmit: true, run: { status: "pending", token } });
      return {
        token,
        serverId: state.selectedServerId,
        request: {
          context: state.context,
          question,
          ...(state.agentId ? { agentId: state.agentId } : {}),
          deadlineMs: ASK_JEV_DEADLINE_MS,
        },
      };
    },
    settle(token, payload) {
      if (state.run.status !== "pending" || state.run.token !== token || !askedQuestion) return;
      update({ run: { status: "settled", result: mapAskJevPayload(payload, askedQuestion) } });
    },
    fail(token, error) {
      if (state.run.status !== "pending" || state.run.token !== token) return;
      update({ run: { status: "settled", result: mapAskJevClientFailure(error) } });
    },
    cancel() {
      // A late answer finds the run no longer pending and is dropped.
      if (state.run.status !== "pending") return;
      update({ run: { status: "cancelled" } });
    },
  };
}
