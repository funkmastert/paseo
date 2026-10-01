import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Logger } from "pino";
import {
  resolveCoordinationConfig,
  type CoordinationConfig,
  type CoordinationConfigInput,
} from "./config.js";
import { createJsonlAppender, type JsonlAppender } from "../jsonl-appender.js";
import { WorkQueueService } from "./queue/service.js";
import { WorkQueueStore, type WorkQueueStoreOptions } from "./queue/store.js";
import { StreamStore } from "./stream/store.js";

// Every Inbox act (OR-A5), win or lose, appends here: who, what verb, what happened. Separate
// from the queue journal (the record of state) and the fleet stream (the feed); this is the
// human-action audit trail. Rotates like every other jsonl-appender log.
const INBOX_AUDIT_MAX_BYTES = 10 * 1024 * 1024;

export interface Coordination {
  config: CoordinationConfig;
  queue: WorkQueueService;
  stream: StreamStore;
  inboxAudit: JsonlAppender;
}

export interface OpenCoordinationOptions {
  paseoHome: string;
  config: CoordinationConfigInput;
  logger: Logger;
  now?: () => Date;
  newId?: () => string;
  onCommitStep?: WorkQueueStoreOptions["onCommitStep"];
}

// Opens the queue and stream under `$PASEO_HOME/coordination/`. Opening the queue completes any
// transaction a crash cut off, so call this before anything reads or writes items.
export async function openCoordination(options: OpenCoordinationOptions): Promise<Coordination> {
  const config = resolveCoordinationConfig(options.config);
  const root = path.join(options.paseoHome, "coordination");
  const logger = options.logger.child({ module: "coordination" });
  const store = await WorkQueueStore.open({
    rootDir: path.join(root, "queue"),
    logger,
    ...(options.onCommitStep ? { onCommitStep: options.onCommitStep } : {}),
  });
  const stream = await StreamStore.open({
    rootDir: path.join(root, "stream"),
    retention: {
      maxEntries: config.retention.streamMaxEntries,
      maxAgeMs: config.retention.streamMaxAgeMs,
    },
    logger,
  });
  const queue = new WorkQueueService({
    store,
    stream,
    retention: config.retention,
    logger,
    now: options.now ?? (() => new Date()),
    newId: options.newId ?? (() => `wi_${randomUUID()}`),
  });
  const inboxAudit = createJsonlAppender({
    filePath: path.join(root, "audit.jsonl"),
    maxBytes: INBOX_AUDIT_MAX_BYTES,
    logger,
  });
  return { config, queue, stream, inboxAudit };
}
