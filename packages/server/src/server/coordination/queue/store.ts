import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import {
  WorkItemSchema,
  WorkItemTransitionSchema,
  type WorkItem,
  type WorkItemClosure,
  type WorkItemDeliveryState,
  type WorkItemListFilter,
  type WorkItemPage,
  type WorkItemState,
  type WorkItemTransition,
  type WorkItemWithTransitions,
} from "@getpaseo/protocol/coordination/queue-schemas";
import { writeFileAtomic, writeJsonFileAtomic } from "../../atomic-file.js";
import { readJsonlFile } from "../jsonl.js";
import { QueueValidationError, isOpenState, validateTransition } from "./state-machine.js";

// One JSON document per item under items/, plus journal.jsonl. Every store method is one
// transaction, committed as: append a `begin` line holding the after-image of every item it
// touches and the transition rows it adds, write each item document, append `commit`. A begin
// without a commit is redone on the next open (or the next call, if this instance saw the
// failure), so a crash at any point either leaves the transaction unstarted or completes it.
// See docs/work-queue.md#storage.

export class QueueConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueConflictError";
  }
}

export class QueueNotFoundError extends Error {
  constructor(id: string) {
    super(`No work item with id "${id}".`);
    this.name = "QueueNotFoundError";
  }
}

const StoredWorkItemSchema = WorkItemSchema.extend({
  // Hash of what create was called with, so a repeat create can tell "same request" from
  // "same id, different work".
  createFingerprint: z.string(),
});
type StoredWorkItem = z.infer<typeof StoredWorkItemSchema>;

const JournalLineSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("header"), nextSeq: z.number().int().positive() }),
  z.object({
    kind: z.literal("begin"),
    txId: z.string(),
    op: z.string(),
    items: z.array(StoredWorkItemSchema),
    transitions: z.array(WorkItemTransitionSchema),
  }),
  z.object({ kind: z.literal("commit"), txId: z.string() }),
  // Written by compaction: a row whose transaction committed before the journal was rewritten.
  z.object({ kind: z.literal("transition"), transition: WorkItemTransitionSchema }),
]);
type JournalLine = z.infer<typeof JournalLineSchema>;
type BeginLine = Extract<JournalLine, { kind: "begin" }>;

const ArchiveLineSchema = z.object({
  archivedAt: z.string(),
  item: WorkItemSchema,
  transitions: z.array(WorkItemTransitionSchema),
});

// Ids become file names on macOS and Windows, so no separators, no colons, no leading dot.
const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

export type CommitStep =
  | { kind: "begun"; op: string; txId: string }
  | { kind: "item-written"; op: string; itemId: string };

export interface WorkQueueStoreOptions {
  // `$PASEO_HOME/coordination/queue`.
  rootDir: string;
  logger: Logger;
  // Test seam: runs after each commit step. Throwing simulates the daemon dying there.
  onCommitStep?: (step: CommitStep) => Promise<void>;
}

export interface CreateWorkItemInput {
  id: string;
  title: string;
  body?: string;
  owner: string;
  createdBy?: string;
  tags?: string[];
}

export interface TransitionInput {
  to: WorkItemState;
  closure?: WorkItemClosure;
  note?: string;
  actor?: string;
  expectedRevision?: number;
}

export interface HandoffInput {
  // The successor's owner: an agent id or `human`.
  to: string;
  actor?: string;
  note?: string;
  title?: string;
  body?: string;
}

export interface UpdateWorkItemInput {
  title?: string;
  body?: string;
  tags?: string[];
  delivery?: WorkItemDeliveryState;
  expectedRevision?: number;
}

export interface WorkItemMutation {
  item: WorkItem;
  // Rows this call added. Empty when the call changed nothing or touched no state.
  transitions: WorkItemTransition[];
  changed: boolean;
}

export interface HandoffResult {
  source: WorkItem;
  successor: WorkItem;
  transitions: WorkItemTransition[];
  changed: boolean;
}

export interface CompactResult {
  archivedItemIds: string[];
}

export function deriveSuccessorId(sourceId: string): string {
  return `wi_${createHash("sha256").update(`handoff:${sourceId}`).digest("hex").slice(0, 24)}`;
}

export class WorkQueueStore {
  private readonly itemsDir: string;
  private readonly journalPath: string;
  private readonly archiveDir: string;
  private items = new Map<string, StoredWorkItem>();
  private transitions = new Map<string, WorkItemTransition[]>();
  private nextSeq = 1;
  private needsReload = false;
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(private readonly options: WorkQueueStoreOptions) {
    this.itemsDir = path.join(options.rootDir, "items");
    this.journalPath = path.join(options.rootDir, "journal.jsonl");
    this.archiveDir = path.join(options.rootDir, "archive");
  }

  static async open(options: WorkQueueStoreOptions): Promise<WorkQueueStore> {
    const store = new WorkQueueStore(options);
    await store.load();
    return store;
  }

  create(input: CreateWorkItemInput, at: string): Promise<WorkItemMutation> {
    return this.serialize(async () => {
      validateCreateInput(input);
      const fingerprint = fingerprintCreate(input);
      const existing = this.items.get(input.id);
      if (existing) {
        if (existing.createFingerprint !== fingerprint) {
          throw new QueueConflictError(
            `Work item "${input.id}" already exists with different content. Mint a new id for ` +
              `new work; repeat a create only with the same title, body, owner and tags.`,
          );
        }
        return { item: toWire(existing), transitions: [], changed: false };
      }
      const item: StoredWorkItem = {
        id: input.id,
        title: input.title,
        body: input.body,
        owner: input.owner,
        createdBy: input.createdBy,
        state: "pending",
        tags: input.tags,
        delivery: { state: "not_attempted" },
        revision: 1,
        createdAt: at,
        updatedAt: at,
        createFingerprint: fingerprint,
      };
      const transitions = [
        this.row({ itemId: item.id, to: "pending", at, actor: input.createdBy, owner: item.owner }),
      ];
      await this.commit("create", [item], transitions);
      return { item: toWire(item), transitions, changed: true };
    });
  }

  claim(id: string, input: { actor: string; note?: string }, at: string): Promise<WorkItemMutation> {
    return this.serialize(async () => {
      const current = this.require(id);
      if (current.state === "in-progress") {
        if (current.owner === input.actor) {
          return { item: toWire(current), transitions: [], changed: false };
        }
        throw new QueueValidationError(
          `Work item "${id}" is already in progress, owned by ${current.owner}. ` +
            `Use handoff to move it to a new owner.`,
        );
      }
      validateTransition({ from: current.state, to: "in-progress" });
      const item: StoredWorkItem = {
        ...current,
        state: "in-progress",
        owner: input.actor,
        closure: undefined,
        claimedAt: at,
        updatedAt: at,
        revision: (current.revision ?? 0) + 1,
      };
      const transitions = [
        this.row({
          itemId: id,
          from: current.state,
          to: "in-progress",
          at,
          actor: input.actor,
          owner: input.actor,
          note: input.note,
        }),
      ];
      await this.commit("claim", [item], transitions);
      return { item: toWire(item), transitions, changed: true };
    });
  }

  transition(id: string, input: TransitionInput, at: string): Promise<WorkItemMutation> {
    return this.serialize(async () => {
      const current = this.require(id);
      checkRevision(current, input.expectedRevision);
      validateTransition({ from: current.state, to: input.to, closure: input.closure });
      const closure = input.closure ?? impliedClosure(input.to);
      const item: StoredWorkItem = {
        ...current,
        state: input.to,
        closure,
        closedAt: isOpenState(input.to) ? undefined : at,
        updatedAt: at,
        revision: (current.revision ?? 0) + 1,
      };
      const transitions = [
        this.row({
          itemId: id,
          from: current.state,
          to: input.to,
          at,
          actor: input.actor,
          owner: item.owner,
          closure,
          note: input.note,
        }),
      ];
      await this.commit("transition", [item], transitions);
      return { item: toWire(item), transitions, changed: true };
    });
  }

  handoff(id: string, input: HandoffInput, at: string): Promise<HandoffResult> {
    return this.serialize(async () => {
      const current = this.require(id);
      const successorId = deriveSuccessorId(id);
      if (current.state === "handed-off" && current.handedOffTo === successorId) {
        const successor = this.items.get(successorId);
        if (successor && successor.owner === input.to && current.closure?.target === input.to) {
          return {
            source: toWire(current),
            successor: toWire(successor),
            transitions: [],
            changed: false,
          };
        }
      }
      if (!input.to.trim()) {
        throw new QueueValidationError(
          `Handoff needs a new owner: an agent id or "human".`,
        );
      }
      const closure: WorkItemClosure = { reason: "handed_off_to", target: input.to };
      validateTransition(
        { from: current.state, to: "handed-off", closure },
        { viaHandoff: true },
      );
      if (this.items.has(successorId)) {
        throw new QueueConflictError(
          `Successor id "${successorId}" for "${id}" is already taken.`,
        );
      }
      const successorInput: CreateWorkItemInput = {
        id: successorId,
        title: input.title ?? current.title,
        body: input.body ?? current.body,
        owner: input.to,
        createdBy: input.actor,
        tags: current.tags,
      };
      const successor: StoredWorkItem = {
        ...successorInput,
        state: "pending",
        handedOffFrom: id,
        delivery: { state: "not_attempted" },
        revision: 1,
        createdAt: at,
        updatedAt: at,
        createFingerprint: fingerprintCreate(successorInput),
      };
      const source: StoredWorkItem = {
        ...current,
        state: "handed-off",
        closure,
        handedOffTo: successorId,
        closedAt: at,
        updatedAt: at,
        revision: (current.revision ?? 0) + 1,
      };
      const transitions = [
        this.row({
          itemId: successorId,
          to: "pending",
          at,
          actor: input.actor,
          owner: input.to,
          note: input.note,
        }),
        this.row({
          itemId: id,
          from: current.state,
          to: "handed-off",
          at,
          actor: input.actor,
          owner: current.owner,
          closure,
          note: input.note,
          successorId,
        }),
      ];
      // Successor first: a crash after it lands and before the source closes is exactly the
      // case the redo has to finish.
      await this.commit("handoff", [successor, source], transitions);
      return {
        source: toWire(source),
        successor: toWire(successor),
        transitions,
        changed: true,
      };
    });
  }

  // Fields that are not state. Adds no transition row.
  update(id: string, input: UpdateWorkItemInput, at: string): Promise<WorkItemMutation> {
    return this.serialize(async () => {
      const current = this.require(id);
      checkRevision(current, input.expectedRevision);
      if (input.title !== undefined && !input.title.trim()) {
        throw new QueueValidationError("A work item title cannot be empty.");
      }
      const item: StoredWorkItem = {
        ...current,
        title: input.title ?? current.title,
        body: input.body ?? current.body,
        tags: input.tags ?? current.tags,
        delivery: input.delivery ?? current.delivery,
        updatedAt: at,
        revision: (current.revision ?? 0) + 1,
      };
      await this.commit("update", [item], []);
      return { item: toWire(item), transitions: [], changed: true };
    });
  }

  get(id: string): Promise<WorkItemWithTransitions | null> {
    return this.serialize(async () => {
      const item = this.items.get(id);
      if (!item) return null;
      return { item: toWire(item), transitions: [...(this.transitions.get(id) ?? [])] };
    });
  }

  // Oldest first by creation, so a page boundary never moves when items change state.
  list(filter: WorkItemListFilter): Promise<WorkItemPage> {
    return this.serialize(async () => {
      const limit = Math.min(filter.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
      const after = filter.cursor ? decodeCursor(filter.cursor) : null;
      const matches = [...this.items.values()]
        .filter((item) => (filter.owner ? item.owner === filter.owner : true))
        .filter((item) => (filter.states ? filter.states.includes(item.state) : true))
        .filter((item) => (filter.openOnly ? isOpenState(item.state) : true))
        .sort(compareByCreation)
        .filter((item) => (after ? compareByCreation(item, after) > 0 : true));
      const page = matches.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toWire),
        nextCursor: matches.length > limit && last ? encodeCursor(last) : undefined,
      };
    });
  }

  // OR-J1. Moves closed items whose close is older than the window, with their transition rows,
  // to archive/<yyyy-mm>.jsonl, then rewrites the journal without them. Open items are never
  // candidates.
  compact(input: { now: string; closedItemMaxAgeMs: number }): Promise<CompactResult> {
    return this.serialize(async () => {
      const cutoff = Date.parse(input.now) - input.closedItemMaxAgeMs;
      const expired = [...this.items.values()]
        .filter((item) => !isOpenState(item.state))
        .filter((item) => Date.parse(item.closedAt ?? item.updatedAt) < cutoff)
        .sort(compareByCreation);

      const byMonth = new Map<string, string[]>();
      for (const item of expired) {
        const month = (item.closedAt ?? item.updatedAt).slice(0, 7);
        const line = JSON.stringify(
          ArchiveLineSchema.parse({
            archivedAt: input.now,
            item: toWire(item),
            transitions: this.transitions.get(item.id) ?? [],
          }),
        );
        byMonth.set(month, [...(byMonth.get(month) ?? []), line]);
      }
      if (byMonth.size > 0) await fs.mkdir(this.archiveDir, { recursive: true });
      for (const [month, lines] of byMonth) {
        await fs.appendFile(path.join(this.archiveDir, `${month}.jsonl`), `${lines.join("\n")}\n`);
      }
      // Delete documents before the journal rewrite: a crash in between leaves rows for missing
      // items, which load ignores and the next compaction drops.
      for (const item of expired) {
        await fs.rm(this.itemPath(item.id), { force: true });
        this.items.delete(item.id);
        this.transitions.delete(item.id);
      }
      await this.rewriteJournal();
      return { archivedItemIds: expired.map((item) => item.id) };
    });
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      if (this.needsReload) await this.load();
      return work();
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  private require(id: string): StoredWorkItem {
    const item = this.items.get(id);
    if (!item) throw new QueueNotFoundError(id);
    return item;
  }

  private row(fields: Omit<WorkItemTransition, "seq">): WorkItemTransition {
    const row = { seq: this.nextSeq, ...fields };
    this.nextSeq += 1;
    return stripUndefined(row);
  }

  private async commit(
    op: string,
    items: StoredWorkItem[],
    transitions: WorkItemTransition[],
  ): Promise<void> {
    const txId = randomUUID();
    const begin: BeginLine = { kind: "begin", txId, op, items, transitions };
    try {
      await this.appendJournal(begin);
      await this.options.onCommitStep?.({ kind: "begun", op, txId });
      for (const item of items) {
        await writeJsonFileAtomic(this.itemPath(item.id), stripUndefined(item));
        await this.options.onCommitStep?.({ kind: "item-written", op, itemId: item.id });
      }
      await this.appendJournal({ kind: "commit", txId });
    } catch (error) {
      // The begin may or may not have landed. Reload before the next call: it redoes the
      // transaction if it did and discards the reserved seqs if it did not.
      this.needsReload = true;
      throw error;
    }
    this.apply(items, transitions);
  }

  private apply(items: StoredWorkItem[], transitions: WorkItemTransition[]): void {
    for (const item of items) this.items.set(item.id, item);
    for (const row of transitions) {
      this.transitions.set(row.itemId, [...(this.transitions.get(row.itemId) ?? []), row]);
      this.nextSeq = Math.max(this.nextSeq, row.seq + 1);
    }
  }

  private async load(): Promise<void> {
    this.items = await this.readItems();
    this.transitions = new Map();
    this.nextSeq = 1;
    const lines = await this.readJournal();
    const pending = new Map<string, BeginLine>();
    for (const line of lines) {
      if (line.kind === "header") {
        this.nextSeq = Math.max(this.nextSeq, line.nextSeq);
      } else if (line.kind === "transition") {
        this.addLoadedRow(line.transition);
      } else if (line.kind === "begin") {
        pending.set(line.txId, line);
      } else {
        const begin = pending.get(line.txId);
        pending.delete(line.txId);
        if (begin) for (const row of begin.transitions) this.addLoadedRow(row);
      }
    }
    for (const begin of pending.values()) {
      this.options.logger.warn(
        { txId: begin.txId, op: begin.op, itemIds: begin.items.map((item) => item.id) },
        "Work queue: completing a transaction cut off before its commit",
      );
      for (const item of begin.items) {
        await writeJsonFileAtomic(this.itemPath(item.id), stripUndefined(item));
        this.items.set(item.id, item);
      }
      await this.appendJournal({ kind: "commit", txId: begin.txId });
      for (const row of begin.transitions) this.addLoadedRow(row);
    }
    this.needsReload = false;
  }

  private addLoadedRow(row: WorkItemTransition): void {
    this.nextSeq = Math.max(this.nextSeq, row.seq + 1);
    if (!this.items.has(row.itemId)) return;
    this.transitions.set(row.itemId, [...(this.transitions.get(row.itemId) ?? []), row]);
  }

  private async readItems(): Promise<Map<string, StoredWorkItem>> {
    const items = new Map<string, StoredWorkItem>();
    let names: string[];
    try {
      names = await fs.readdir(this.itemsDir);
    } catch (error) {
      if (isMissing(error)) return items;
      throw error;
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const filePath = path.join(this.itemsDir, name);
      try {
        const item = StoredWorkItemSchema.parse(JSON.parse(await fs.readFile(filePath, "utf8")));
        items.set(item.id, item);
      } catch (error) {
        this.options.logger.error({ err: error, filePath }, "Work queue: unreadable item file");
      }
    }
    return items;
  }

  // A torn last line never had a matching commit, so dropping it loses nothing.
  private readJournal(): Promise<JournalLine[]> {
    return readJsonlFile(
      this.journalPath,
      (value) => {
        const result = JournalLineSchema.safeParse(value);
        return result.success ? result.data : null;
      },
      this.options.logger,
    );
  }

  private async appendJournal(line: JournalLine): Promise<void> {
    await fs.mkdir(this.options.rootDir, { recursive: true });
    await fs.appendFile(this.journalPath, `${JSON.stringify(line)}\n`);
  }

  private async rewriteJournal(): Promise<void> {
    const rows = [...this.transitions.values()].flat().sort((a, b) => a.seq - b.seq);
    const lines: JournalLine[] = [
      { kind: "header", nextSeq: this.nextSeq },
      ...rows.map((transition) => ({ kind: "transition" as const, transition })),
    ];
    await writeFileAtomic(
      this.journalPath,
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
  }

  private itemPath(id: string): string {
    return path.join(this.itemsDir, `${id}.json`);
  }
}

function validateCreateInput(input: CreateWorkItemInput): void {
  if (!ITEM_ID_PATTERN.test(input.id)) {
    throw new QueueValidationError(
      `Work item id "${input.id}" is not usable. Use 1-128 letters, digits, ".", "_" or "-", ` +
        `starting with a letter or digit.`,
    );
  }
  if (!input.title.trim()) {
    throw new QueueValidationError("A work item needs a title.");
  }
  if (!input.owner.trim()) {
    throw new QueueValidationError(`A work item needs an owner: an agent id or "human".`);
  }
}

function fingerprintCreate(input: CreateWorkItemInput): string {
  const canonical = JSON.stringify([
    input.title,
    input.body ?? null,
    input.owner,
    input.createdBy ?? null,
    input.tags ?? [],
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

function impliedClosure(to: WorkItemState): WorkItemClosure | undefined {
  if (to === "denied") return { reason: "denied" };
  if (to === "canceled") return { reason: "canceled" };
  return undefined;
}

function checkRevision(item: StoredWorkItem, expected: number | undefined): void {
  if (expected !== undefined && item.revision !== expected) {
    throw new QueueConflictError(
      `Work item "${item.id}" changed since you read it (revision ${item.revision}, you sent ` +
        `${expected}). Read it again and retry.`,
    );
  }
}

function toWire(item: StoredWorkItem): WorkItem {
  const { createFingerprint: _fingerprint, ...wire } = item;
  return stripUndefined(wire);
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function compareByCreation(
  a: Pick<WorkItem, "createdAt" | "id">,
  b: Pick<WorkItem, "createdAt" | "id">,
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

const CursorSchema = z.tuple([z.string(), z.string()]);

function encodeCursor(item: Pick<WorkItem, "createdAt" | "id">): string {
  return Buffer.from(JSON.stringify([item.createdAt, item.id])).toString("base64url");
}

function decodeCursor(cursor: string): Pick<WorkItem, "createdAt" | "id"> {
  try {
    const [createdAt, id] = CursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
    return { createdAt, id };
  } catch {
    throw new QueueValidationError(
      "That cursor is not one this queue returned. Pass the nextCursor from the previous page.",
    );
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
