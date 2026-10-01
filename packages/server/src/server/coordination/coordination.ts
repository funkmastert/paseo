import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Logger } from "pino";
import {
  resolveCoordinationConfig,
  type CoordinationConfig,
  type CoordinationConfigInput,
} from "./config.js";
import { WorkQueueService } from "./queue/service.js";
import { WorkQueueStore } from "./queue/store.js";
import { StreamStore } from "./stream/store.js";

export interface Coordination {
  config: CoordinationConfig;
  queue: WorkQueueService;
  stream: StreamStore;
}

export interface OpenCoordinationOptions {
  paseoHome: string;
  config: CoordinationConfigInput;
  logger: Logger;
  now?: () => Date;
  newId?: () => string;
}

// Opens the queue and stream under `$PASEO_HOME/coordination/`. Opening the queue completes any
// transaction a crash cut off, so call this before anything reads or writes items.
export async function openCoordination(options: OpenCoordinationOptions): Promise<Coordination> {
  const config = resolveCoordinationConfig(options.config);
  const root = path.join(options.paseoHome, "coordination");
  const logger = options.logger.child({ module: "coordination" });
  const store = await WorkQueueStore.open({ rootDir: path.join(root, "queue"), logger });
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
  return { config, queue, stream };
}
