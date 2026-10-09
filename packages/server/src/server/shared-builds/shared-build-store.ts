/**
 * Builds an agent shared with Tyler's phone (docs/shared-builds.md). Each one lives in
 * `<root>/<token>/` beside its `share.json`, which is the source of truth for expiry and the
 * total-size cap. The public static server reads the same file to refuse an expired link.
 *
 * Every share and sweep runs one at a time, so a sweep never sees another share's temp directory
 * as anything but a crash leftover, and two shares can't both fit under the cap by racing.
 */

import { createHash, randomBytes } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Logger } from "pino";
import { z } from "zod";
import type { ResolvedSharedBuildsConfig } from "./config.js";
import { formatBytes } from "../session/doctor/helpers.js";
import { readFreeDiskBytes } from "./free-disk.js";

export const SHARE_RECORD_FILE = "share.json";
/** 128 random bits, base64url. The server serves only names of this shape. */
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const TEMP_PREFIX = ".tmp-";
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const SharedBuildAppSchema = z.object({
  name: z.string().nullable(),
  version: z.string().nullable(),
  build: z.string().nullable(),
  identifier: z.string().nullable(),
});

const SharedBuildRecordSchema = z.object({
  version: z.literal(1),
  token: z.string(),
  agentId: z.string().nullable(),
  platform: z.enum(["android", "ios"]),
  fileName: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  app: SharedBuildAppSchema,
});

export type SharedBuildApp = z.infer<typeof SharedBuildAppSchema>;
export type SharedBuildRecord = z.infer<typeof SharedBuildRecordSchema>;
export type SharedBuildPlatform = SharedBuildRecord["platform"];

export interface SharedBuildsLimits extends ResolvedSharedBuildsConfig {
  /** The disk brake's low line: a share that would leave less free than this is refused. */
  lowFreeBytes: number;
}

export interface SharedBuildUrls {
  /** `<base>/b/<token>/`; the server answers it with the share's `index.html`, if it has one. */
  directory: string;
  /** The build file itself. */
  file: string;
}

/** What a share's finishing step sees: the copied file in the share's not-yet-live directory. */
export interface SharedBuildFinishInput {
  directory: string;
  fileName: string;
  urls: SharedBuildUrls;
}

export interface ShareBuildRequest {
  /** A real path the caller already confined; opened without following a symlink. */
  sourcePath: string;
  /** The validated file's identity. A different file at the path by open time is refused. */
  identity?: { dev: number; ino: number };
  agentId: string | null;
  platform: SharedBuildPlatform;
  /**
   * Runs on the copy before the share goes live: reads the app's metadata and writes any extra
   * files (an iOS manifest and install page). Throw a SharedBuildRefusal to refuse the build.
   */
  finish?: (input: SharedBuildFinishInput) => Promise<SharedBuildApp>;
}

export interface SharedBuild {
  record: SharedBuildRecord;
  urls: SharedBuildUrls;
}

export interface SharedBuildSweepResult {
  expired: number;
  evicted: number;
  /** Half-written shares a crash left behind, and directories whose `share.json` is unreadable. */
  partial: number;
}

/** A share the store refused; the message is written for the agent that asked. */
export class SharedBuildRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharedBuildRefusal";
  }
}

export interface SharedBuildStoreOptions {
  root: string;
  readLimits: () => SharedBuildsLimits;
  readFreeBytes?: (target: string) => Promise<number | null>;
  now?: () => number;
  logger: Logger;
}

const NO_APP: SharedBuildApp = { name: null, version: null, build: null, identifier: null };

/** The original name, reduced to characters every URL and filesystem takes as they are. */
function storedFileName(sourcePath: string, platform: SharedBuildPlatform): string {
  const extension = platform === "ios" ? ".ipa" : ".apk";
  const stem = path
    .basename(sourcePath, path.extname(sourcePath))
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 80);
  return `${stem || "build"}${extension}`;
}

export function buildSharedBuildUrls(input: {
  publicBaseUrl: string;
  token: string;
  fileName: string;
}): SharedBuildUrls {
  const directory = `${input.publicBaseUrl}/b/${input.token}/`;
  return { directory, file: `${directory}${encodeURIComponent(input.fileName)}` };
}

/** Counts the bytes through and fails the copy once they pass the cap; hashes what it passes. */
class CappedHashStream extends Transform {
  readonly hash = createHash("sha256");
  bytes = 0;

  constructor(private readonly maxBytes: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      callback(
        new SharedBuildRefusal(
          `The build grew past the ${formatBytes(this.maxBytes)} cap while it was being copied.`,
        ),
      );
      return;
    }
    this.hash.update(chunk);
    callback(null, chunk);
  }
}

export class SharedBuildStore {
  private readonly readFreeBytes: (target: string) => Promise<number | null>;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: SharedBuildStoreOptions) {
    this.readFreeBytes = options.readFreeBytes ?? readFreeDiskBytes;
    this.now = options.now ?? Date.now;
  }

  get root(): string {
    return this.options.root;
  }

  /** Sweeps now, then hourly. A sweep that fails is logged and tried again next hour. */
  start(): void {
    if (this.timer) return;
    const run = () => {
      this.sweep().catch((error: unknown) => {
        this.options.logger.warn({ err: error }, "Shared builds sweep failed");
      });
    };
    run();
    this.timer = setInterval(run, SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  share(request: ShareBuildRequest): Promise<SharedBuild> {
    return this.exclusive(() => this.shareNow(request));
  }

  sweep(): Promise<SharedBuildSweepResult> {
    return this.exclusive(() => this.sweepNow(0));
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async shareNow(request: ShareBuildRequest): Promise<SharedBuild> {
    const limits = this.options.readLimits();
    if (!limits.enabled) {
      throw new SharedBuildRefusal(
        "Sharing builds is turned off on this daemon (agents.sharedBuilds.enabled is false).",
      );
    }
    const publicBaseUrl = limits.publicBaseUrl;
    if (!publicBaseUrl) {
      throw new SharedBuildRefusal(
        "This daemon has no https app.baseUrl in config.json, so there is no public site to host the build.",
      );
    }

    const handle = await fs.open(
      request.sourcePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    let tempDirectory: string | null = null;
    try {
      const stat = await handle.stat();
      const identity = request.identity;
      // Windows can report 0 for both on some volumes; there the caller's realpath check stands alone.
      if (
        identity &&
        (identity.dev !== 0 || identity.ino !== 0) &&
        (stat.dev !== identity.dev || stat.ino !== identity.ino)
      ) {
        throw new SharedBuildRefusal("The file changed while it was being shared; share it again.");
      }
      if (!stat.isFile()) throw new SharedBuildRefusal("Only a regular file can be shared.");
      if (stat.size === 0) throw new SharedBuildRefusal("The file is empty.");
      const maxBytes = Math.min(limits.maxFileBytes, limits.maxTotalBytes);
      if (stat.size > maxBytes) {
        throw new SharedBuildRefusal(
          `The build is ${formatBytes(stat.size)}, over the ${formatBytes(maxBytes)} cap for one shared build.`,
        );
      }

      await fs.mkdir(this.root, { recursive: true });
      const freeBytes = await this.readFreeBytes(this.root);
      if (freeBytes === null) {
        throw new SharedBuildRefusal(
          "Free disk space could not be read, so the build was not copied.",
        );
      }
      if (freeBytes - stat.size < limits.lowFreeBytes) {
        throw new SharedBuildRefusal(
          `Disk space is low (${formatBytes(freeBytes)} free, the floor is ${formatBytes(limits.lowFreeBytes)}), so no build is being shared. Try again once space is freed.`,
        );
      }
      // Expired shares go, then the oldest, until this one fits under the total cap.
      await this.sweepNow(stat.size);

      const token = randomBytes(16).toString("base64url");
      const fileName = storedFileName(request.sourcePath, request.platform);
      const urls = buildSharedBuildUrls({ publicBaseUrl, token, fileName });
      tempDirectory = path.join(this.root, `${TEMP_PREFIX}${token}`);
      await fs.mkdir(tempDirectory);

      const counter = new CappedHashStream(maxBytes);
      await pipeline(
        handle.createReadStream({ autoClose: false, start: 0 }),
        counter,
        createWriteStream(path.join(tempDirectory, fileName), { flags: "wx" }),
      );
      const app = request.finish
        ? await request.finish({ directory: tempDirectory, fileName, urls })
        : NO_APP;

      const createdAtMs = this.now();
      const record: SharedBuildRecord = {
        version: 1,
        token,
        agentId: request.agentId,
        platform: request.platform,
        fileName,
        bytes: counter.bytes,
        sha256: counter.hash.digest("hex"),
        createdAt: new Date(createdAtMs).toISOString(),
        expiresAt: new Date(createdAtMs + limits.expiryMs).toISOString(),
        app,
      };
      await fs.writeFile(
        path.join(tempDirectory, SHARE_RECORD_FILE),
        `${JSON.stringify(record, null, 2)}\n`,
      );
      // The share goes live in one rename: the server never sees a directory without its record.
      await fs.rename(tempDirectory, path.join(this.root, token));
      tempDirectory = null;
      return { record, urls };
    } finally {
      await handle.close().catch(() => undefined);
      if (tempDirectory) await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  }

  /**
   * Deletes expired shares and crash leftovers, then evicts the oldest until the live ones plus
   * `reserveBytes` fit under the total cap.
   */
  private async sweepNow(reserveBytes: number): Promise<SharedBuildSweepResult> {
    const result: SharedBuildSweepResult = { expired: 0, evicted: 0, partial: 0 };
    let entries: string[];
    try {
      entries = await fs.readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
      throw error;
    }
    const nowMs = this.now();
    const live: SharedBuildRecord[] = [];
    for (const entry of entries) {
      const directory = path.join(this.root, entry);
      if (entry.startsWith(TEMP_PREFIX)) {
        // Shares run one at a time, so a temp directory seen here is from a crash.
        await fs.rm(directory, { recursive: true, force: true });
        result.partial += 1;
        continue;
      }
      // Anything that isn't a share this store made is left alone.
      if (!SHARE_TOKEN_PATTERN.test(entry)) continue;
      const record = await readShareRecord(directory);
      if (!record || record.token !== entry) {
        await fs.rm(directory, { recursive: true, force: true });
        result.partial += 1;
        continue;
      }
      if (Date.parse(record.expiresAt) <= nowMs) {
        await fs.rm(directory, { recursive: true, force: true });
        result.expired += 1;
        continue;
      }
      live.push(record);
    }

    const { maxTotalBytes } = this.options.readLimits();
    live.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    let totalBytes = live.reduce((sum, record) => sum + record.bytes, 0);
    for (const record of live) {
      if (totalBytes + reserveBytes <= maxTotalBytes) break;
      await fs.rm(path.join(this.root, record.token), { recursive: true, force: true });
      totalBytes -= record.bytes;
      result.evicted += 1;
    }
    if (result.expired + result.evicted + result.partial > 0) {
      this.options.logger.info({ ...result, root: this.root }, "Shared builds swept");
    }
    return result;
  }
}

/** The share's record, or null when it is missing or unreadable as one. Other read errors throw. */
async function readShareRecord(directory: string): Promise<SharedBuildRecord | null> {
  let text: string;
  try {
    text = await fs.readFile(path.join(directory, SHARE_RECORD_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const result = SharedBuildRecordSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
