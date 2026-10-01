import type { Command } from "commander";
import type {
  WorkItem,
  WorkItemClosure,
  WorkItemTransition,
} from "@getpaseo/protocol/coordination/queue-schemas";
import { WORK_ITEM_CLOSURE_REASONS } from "@getpaseo/protocol/coordination/queue-schemas";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  CommandError,
  CommandOptions,
  ListResult,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";

// `paseo queue`: the work queue from a terminal (docs/work-queue.md#cli). Reads are compact unless
// --full. Every write ends with what happened, the item's state now and the next action
// (principle 8 of the OpenRig port plan). There is no health pre-flight: the request goes out and
// its own failure is reported (OR-A1 reliability note).

export type QueueClient = Pick<
  DaemonClient,
  | "coordinationQueueCreate"
  | "coordinationQueueClaim"
  | "coordinationQueueTransition"
  | "coordinationQueueHandoff"
  | "coordinationQueueList"
  | "coordinationQueueShow"
  | "getLastServerInfoMessage"
>;

export interface QueueOptions extends CommandOptions {
  full?: boolean;
  as?: string;
}

/** Who is acting: `--as`, else the agent this shell belongs to, else `human`. */
export function resolveQueueActor(options: { as?: string }, env = process.env): string {
  return options.as?.trim() || env.PASEO_AGENT_ID?.trim() || "human";
}

/** `reason` or `reason=target`, the same grammar as the closure marker. */
export function parseClosureOption(value: string): WorkItemClosure {
  const separator = value.indexOf("=");
  const reason = separator === -1 ? value : value.slice(0, separator);
  const target = separator === -1 ? undefined : value.slice(separator + 1);
  const match = WORK_ITEM_CLOSURE_REASONS.find((candidate) => candidate === reason);
  if (!match) {
    const error: CommandError = {
      code: "INVALID_CLOSURE",
      message: `Unknown closure "${value}". Use one of: ${WORK_ITEM_CLOSURE_REASONS.join(", ")} (add =<target> for handed_off_to, blocked_on, escalation).`,
    };
    throw error;
  }
  return target ? { reason: match, target } : { reason: match };
}

function formatClosure(closure: WorkItemClosure | undefined): string {
  if (!closure) return "";
  return closure.target ? `${closure.reason}=${closure.target}` : closure.reason;
}

/** The next action for whoever ran the command, given the item's state now. */
export function nextQueueStep(item: WorkItem, actor: string): string {
  switch (item.state) {
    case "pending":
      return item.owner === actor
        ? `paseo queue claim ${item.id} when you start.`
        : `waiting for ${item.owner} to claim it; \`paseo queue show ${item.id}\` to check.`;
    case "in-progress":
      return item.owner === actor
        ? `when finished, \`paseo queue done ${item.id} --closure no-follow-on\` (or handed_off_to=<owner>, blocked_on=<target>, escalation=<target>).`
        : `${item.owner} is working on it.`;
    case "blocked":
      return `unblock it when ${item.closure?.target ?? "the blocker"} clears: \`paseo queue claim ${item.id}\`.`;
    case "handed-off":
      return `the work continues as ${item.handedOffTo}: \`paseo queue show ${item.handedOffTo}\`.`;
    default:
      return "nothing; the item is closed. Follow-on work is a new item.";
  }
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

export interface QueueWriteResult {
  action: string;
  changed: boolean;
  item: WorkItem;
  successor?: WorkItem;
  next: string;
}

export function renderQueueWrite(result: QueueWriteResult): string {
  const shown = result.successor ?? result.item;
  const lines = [
    `${result.action} ${result.item.id} "${result.item.title}".${result.changed ? "" : " (no change; it already was)"}`,
  ];
  if (result.successor) {
    lines.push(`Successor: ${result.successor.id}, owner ${result.successor.owner}.`);
  }
  const closure = formatClosure(shown.closure);
  const delivery = shown.delivery?.state;
  lines.push(
    `State: ${shown.state} · owner ${shown.owner}${closure ? ` · ${closure}` : ""}${delivery ? ` · delivery ${delivery}` : ""}`,
  );
  lines.push(`Next: ${result.next}`);
  return lines.join("\n");
}

const queueWriteSchema: OutputSchema<QueueWriteResult> = {
  idField: (result) => (result.successor ?? result.item).id,
  columns: [],
  renderHuman(result) {
    return result.type === "single" ? renderQueueWrite(result.data) : "";
  },
};

function single(data: QueueWriteResult): SingleResult<QueueWriteResult> {
  return { type: "single", data, schema: queueWriteSchema };
}

interface MutationPayload {
  item?: WorkItem;
  successor?: WorkItem;
  changed?: boolean;
  error?: string;
  errorCode?: string;
}

function requireItem(payload: MutationPayload): WorkItem {
  if (payload.error || !payload.item) throw toQueueError(payload);
  return payload.item;
}

function toQueueError(payload: { error?: string; errorCode?: string }): CommandError {
  return {
    code: `QUEUE_${(payload.errorCode ?? "failed").toUpperCase()}`,
    message: payload.error ?? "The daemon returned no item.",
  };
}

export async function queueCreate(
  client: QueueClient,
  input: { title: string; owner: string; body?: string; tags?: string[]; id?: string },
  actor: string,
): Promise<QueueWriteResult> {
  const payload = await client.coordinationQueueCreate({ ...input, actor });
  const item = requireItem(payload);
  return {
    action: "Created",
    changed: payload.changed !== false,
    item,
    next: nextQueueStep(item, actor),
  };
}

export async function queueClaim(
  client: QueueClient,
  id: string,
  actor: string,
): Promise<QueueWriteResult> {
  const payload = await client.coordinationQueueClaim({ id, actor });
  const item = requireItem(payload);
  return {
    action: "Claimed",
    changed: payload.changed !== false,
    item,
    next: nextQueueStep(item, actor),
  };
}

export async function queueDone(
  client: QueueClient,
  input: { id: string; closure?: WorkItemClosure; note?: string },
  actor: string,
): Promise<QueueWriteResult> {
  const payload = await client.coordinationQueueTransition({
    id: input.id,
    to: "done",
    ...(input.closure ? { closure: input.closure } : {}),
    ...(input.note ? { note: input.note } : {}),
    actor,
  });
  const item = requireItem(payload);
  return {
    action: "Closed",
    changed: payload.changed !== false,
    item,
    next: nextQueueStep(item, actor),
  };
}

export async function queueBlock(
  client: QueueClient,
  input: { id: string; on: string; note?: string },
  actor: string,
): Promise<QueueWriteResult> {
  const payload = await client.coordinationQueueTransition({
    id: input.id,
    to: "blocked",
    closure: { reason: "blocked_on", target: input.on },
    ...(input.note ? { note: input.note } : {}),
    actor,
  });
  const item = requireItem(payload);
  return {
    action: "Blocked",
    changed: payload.changed !== false,
    item,
    next: nextQueueStep(item, actor),
  };
}

export async function queueHandoff(
  client: QueueClient,
  input: { id: string; to: string; note?: string },
  actor: string,
): Promise<QueueWriteResult> {
  const payload = await client.coordinationQueueHandoff({
    id: input.id,
    to: input.to,
    ...(input.note ? { note: input.note } : {}),
    actor,
  });
  const item = requireItem(payload);
  if (!payload.successor) throw toQueueError(payload);
  return {
    action: "Handed off",
    changed: payload.changed !== false,
    item,
    successor: payload.successor,
    next: nextQueueStep(payload.successor, actor),
  };
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export interface QueueRow {
  id: string;
  state: string;
  owner: string;
  title: string;
  closure: string;
  delivery: string;
  updatedAt: string;
  item: WorkItem;
}

function toQueueRow(item: WorkItem): QueueRow {
  return {
    id: item.id,
    state: item.state,
    owner: item.owner,
    title: item.title.length > 60 ? `${item.title.slice(0, 59)}…` : item.title,
    closure: formatClosure(item.closure),
    delivery: item.delivery?.state ?? "",
    updatedAt: item.updatedAt,
    item,
  };
}

export function queueListSchema(full: boolean): OutputSchema<QueueRow> {
  return {
    idField: "id",
    columns: [
      { header: "ID", field: "id" },
      { header: "STATE", field: "state" },
      { header: "OWNER", field: "owner" },
      { header: "TITLE", field: "title" },
      { header: "CLOSURE", field: "closure" },
      ...(full
        ? [
            { header: "DELIVERY", field: "delivery" as const },
            { header: "UPDATED", field: "updatedAt" as const },
          ]
        : []),
    ],
    serialize: (row) =>
      full
        ? row.item
        : {
            id: row.id,
            state: row.state,
            owner: row.owner,
            title: row.title,
            closure: row.closure,
          },
  };
}

export async function queueList(
  client: QueueClient,
  input: { owner?: string; states?: WorkItem["state"][]; all?: boolean; limit?: number },
): Promise<QueueRow[]> {
  const payload = await client.coordinationQueueList({
    filter: {
      ...(input.owner ? { owner: input.owner } : {}),
      ...(input.states?.length ? { states: input.states } : {}),
      openOnly: !input.all && !input.states?.length,
      ...(input.limit ? { limit: input.limit } : {}),
    },
  });
  if (payload.error || !payload.items) throw toQueueError(payload);
  return payload.items.map(toQueueRow);
}

export interface QueueShowResult {
  item: WorkItem;
  transitions: WorkItemTransition[];
  full: boolean;
}

export function renderQueueShow(result: QueueShowResult): string {
  const { item, full } = result;
  const lines = [
    `${item.id}  ${item.state}  owner ${item.owner}`,
    item.title,
    ...(item.closure ? [`closure: ${formatClosure(item.closure)}`] : []),
    ...(item.handedOffFrom ? [`handed off from: ${item.handedOffFrom}`] : []),
    ...(item.handedOffTo ? [`handed off to: ${item.handedOffTo}`] : []),
    ...(item.delivery
      ? [
          `delivery: ${item.delivery.state}${item.delivery.reason ? ` (${item.delivery.reason})` : ""}`,
        ]
      : []),
  ];
  if (item.body) {
    lines.push(
      "",
      full || item.body.length <= 400 ? item.body : `${item.body.slice(0, 399)}… (--full for all)`,
    );
  }
  const transitions = full ? result.transitions : result.transitions.slice(-5);
  if (transitions.length > 0) {
    lines.push("", "transitions:");
    for (const row of transitions) {
      const closure = row.closure ? ` ${formatClosure(row.closure)}` : "";
      lines.push(`  ${row.at}  ${row.from ?? "new"} → ${row.to}${closure}  by ${row.actor ?? "?"}`);
    }
  }
  return lines.join("\n");
}

const queueShowSchema: OutputSchema<QueueShowResult> = {
  idField: (result) => result.item.id,
  columns: [],
  renderHuman(result) {
    return result.type === "single" ? renderQueueShow(result.data) : "";
  },
  serialize: (result) =>
    result.full
      ? { item: result.item, transitions: result.transitions }
      : { item: result.item, transitions: result.transitions.slice(-5) },
};

export async function queueShow(
  client: QueueClient,
  id: string,
  full: boolean,
): Promise<QueueShowResult> {
  const payload = await client.coordinationQueueShow({ id });
  if (payload.error || !payload.item) throw toQueueError(payload);
  return { item: payload.item, transitions: payload.transitions ?? [], full };
}

// ---------------------------------------------------------------------------------------------
// Commander runners
// ---------------------------------------------------------------------------------------------

export interface QueueCreateOptions extends QueueOptions {
  owner?: string;
  body?: string;
  tag?: string[];
  id?: string;
}

export interface QueueBlockOptions extends QueueOptions {
  on?: string;
  note?: string;
}

export interface QueueHandoffOptions extends QueueOptions {
  to?: string;
  note?: string;
}

/** Commander enforces these with requiredOption; this narrows the type. */
function requiredOption(value: string | undefined, flag: string): string {
  if (!value) {
    const error: CommandError = { code: "INVALID_OPTIONS", message: `${flag} is required` };
    throw error;
  }
  return value;
}

async function withQueueClient<T>(
  options: QueueOptions,
  run: (client: QueueClient) => Promise<T>,
): Promise<T> {
  let client: DaemonClient;
  try {
    client = await connectToDaemon({ host: options.host });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure: CommandError = {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${getDaemonHost({ host: options.host })}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    };
    throw failure;
  }
  try {
    // COMPAT(coordinationQueue): an older daemon would never answer the request.
    if (client.getLastServerInfoMessage()?.features?.coordinationQueue !== true) {
      const unsupported: CommandError = {
        code: "QUEUE_DISABLED",
        message:
          "The work queue is off on this daemon (or the daemon is too old). Set " +
          "agents.coordination.enabled to true in config.json and restart the daemon.",
      };
      throw unsupported;
    }
    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function runQueueLsCommand(
  options: QueueOptions & { owner?: string; state?: string[]; all?: boolean; limit?: string },
  _command: Command,
): Promise<ListResult<QueueRow>> {
  const rows = await withQueueClient(options, (client) =>
    queueList(client, {
      ...(options.owner
        ? { owner: options.owner === "me" ? resolveQueueActor(options) : options.owner }
        : {}),
      ...(options.state ? { states: options.state as WorkItem["state"][] } : {}),
      ...(options.all ? { all: true } : {}),
      ...(options.limit ? { limit: Number(options.limit) } : {}),
    }),
  );
  return { type: "list", data: rows, schema: queueListSchema(options.full === true) };
}

export async function runQueueShowCommand(
  id: string,
  options: QueueOptions,
  _command: Command,
): Promise<SingleResult<QueueShowResult>> {
  const data = await withQueueClient(options, (client) =>
    queueShow(client, id, options.full === true),
  );
  return { type: "single", data, schema: queueShowSchema };
}

export async function runQueueCreateCommand(
  title: string,
  options: QueueCreateOptions,
  _command: Command,
): Promise<SingleResult<QueueWriteResult>> {
  const actor = resolveQueueActor(options);
  return single(
    await withQueueClient(options, (client) =>
      queueCreate(
        client,
        {
          title,
          owner: requiredOption(options.owner, "--owner"),
          ...(options.body ? { body: options.body } : {}),
          ...(options.tag?.length ? { tags: options.tag } : {}),
          ...(options.id ? { id: options.id } : {}),
        },
        actor,
      ),
    ),
  );
}

export async function runQueueClaimCommand(
  id: string,
  options: QueueOptions,
  _command: Command,
): Promise<SingleResult<QueueWriteResult>> {
  const actor = resolveQueueActor(options);
  return single(await withQueueClient(options, (client) => queueClaim(client, id, actor)));
}

export async function runQueueDoneCommand(
  id: string,
  options: QueueOptions & { closure?: string; note?: string },
  _command: Command,
): Promise<SingleResult<QueueWriteResult>> {
  const actor = resolveQueueActor(options);
  const closure = options.closure ? parseClosureOption(options.closure) : undefined;
  return single(
    await withQueueClient(options, (client) =>
      queueDone(
        client,
        { id, ...(closure ? { closure } : {}), ...(options.note ? { note: options.note } : {}) },
        actor,
      ),
    ),
  );
}

export async function runQueueBlockCommand(
  id: string,
  options: QueueBlockOptions,
  _command: Command,
): Promise<SingleResult<QueueWriteResult>> {
  const actor = resolveQueueActor(options);
  return single(
    await withQueueClient(options, (client) =>
      queueBlock(
        client,
        {
          id,
          on: requiredOption(options.on, "--on"),
          ...(options.note ? { note: options.note } : {}),
        },
        actor,
      ),
    ),
  );
}

export async function runQueueHandoffCommand(
  id: string,
  options: QueueHandoffOptions,
  _command: Command,
): Promise<SingleResult<QueueWriteResult>> {
  const actor = resolveQueueActor(options);
  return single(
    await withQueueClient(options, (client) =>
      queueHandoff(
        client,
        {
          id,
          to: requiredOption(options.to, "--to"),
          ...(options.note ? { note: options.note } : {}),
        },
        actor,
      ),
    ),
  );
}
