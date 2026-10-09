import { mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { resolveSharedBuildsConfig } from "./config.js";
import {
  SHARE_RECORD_FILE,
  SHARE_TOKEN_PATTERN,
  SharedBuildRefusal,
  SharedBuildStore,
  type SharedBuildsLimits,
} from "./shared-build-store.js";

const BASE_URL = "https://shares.example.com";
const HOUR_MS = 60 * 60 * 1000;
const GIB = 1024 * 1024 * 1024;

let workDir: string;
let root: string;
let nowMs: number;
let freeBytes: number | null;
let limits: SharedBuildsLimits;

function createStore(): SharedBuildStore {
  return new SharedBuildStore({
    root,
    readLimits: () => limits,
    readFreeBytes: async () => freeBytes,
    now: () => nowMs,
    logger: createTestLogger(),
  });
}

async function writeBuild(name: string, bytes: number): Promise<string> {
  const file = path.join(workDir, name);
  await fs.writeFile(file, Buffer.alloc(bytes, 7));
  return file;
}

async function liveTokens(): Promise<string[]> {
  const entries = await fs.readdir(root).catch(() => []);
  return entries.filter((entry) => SHARE_TOKEN_PATTERN.test(entry)).sort();
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), "shared-builds-src-"));
  root = mkdtempSync(path.join(os.tmpdir(), "shared-builds-root-"));
  nowMs = Date.parse("2026-10-08T12:00:00.000Z");
  freeBytes = 100 * GIB;
  limits = {
    enabled: true,
    maxFileBytes: 4096,
    maxTotalBytes: 10_000,
    expiryMs: 72 * HOUR_MS,
    publicBaseUrl: BASE_URL,
    lowFreeBytes: 20 * GIB,
  };
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("SharedBuildStore.share", () => {
  test("copies the build and its record under a fresh token", async () => {
    const source = await writeBuild("app debug.apk", 1000);
    const shared = await createStore().share({
      sourcePath: source,
      agentId: "agent-1",
      platform: "android",
    });

    const { record, urls } = shared;
    expect(record.token).toMatch(SHARE_TOKEN_PATTERN);
    expect(record.fileName).toBe("app-debug.apk");
    expect(record).toMatchObject({
      version: 1,
      agentId: "agent-1",
      platform: "android",
      bytes: 1000,
      createdAt: "2026-10-08T12:00:00.000Z",
      expiresAt: "2026-10-11T12:00:00.000Z",
    });
    expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(urls.file).toBe(`${BASE_URL}/b/${record.token}/app-debug.apk`);
    expect(urls.directory).toBe(`${BASE_URL}/b/${record.token}/`);

    const directory = path.join(root, record.token);
    expect((await fs.readFile(path.join(directory, "app-debug.apk"))).length).toBe(1000);
    const onDisk = JSON.parse(await fs.readFile(path.join(directory, SHARE_RECORD_FILE), "utf8"));
    expect(onDisk).toEqual(record);
    expect(await fs.readdir(root)).toEqual([record.token]);
  });

  test("two shares of one file get different tokens", async () => {
    const source = await writeBuild("app.apk", 100);
    const store = createStore();
    const first = await store.share({ sourcePath: source, agentId: null, platform: "android" });
    const second = await store.share({ sourcePath: source, agentId: null, platform: "android" });
    expect(first.record.token).not.toBe(second.record.token);
    expect(await liveTokens()).toHaveLength(2);
  });

  test("refuses a file over the per-file cap and writes nothing", async () => {
    const source = await writeBuild("big.apk", 5000);
    await expect(
      createStore().share({ sourcePath: source, agentId: null, platform: "android" }),
    ).rejects.toThrow(/over the 4.0 KB cap/);
    expect(await fs.readdir(root)).toEqual([]);
  });

  test("refuses while free disk would fall under the low line", async () => {
    const source = await writeBuild("app.apk", 1000);
    freeBytes = 20 * GIB + 500;
    const error = await createStore()
      .share({ sourcePath: source, agentId: null, platform: "android" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SharedBuildRefusal);
    expect((error as Error).message).toMatch(/Disk space is low/);
    expect(await fs.readdir(root)).toEqual([]);
  });

  test("refuses when free disk can't be read", async () => {
    const source = await writeBuild("app.apk", 1000);
    freeBytes = null;
    await expect(
      createStore().share({ sourcePath: source, agentId: null, platform: "android" }),
    ).rejects.toThrow(/could not be read/);
  });

  test("refuses when the feature is off", async () => {
    const source = await writeBuild("app.apk", 100);
    limits = { ...limits, enabled: false };
    await expect(
      createStore().share({ sourcePath: source, agentId: null, platform: "android" }),
    ).rejects.toThrow(/turned off/);
  });

  test("refuses without a public https base URL", async () => {
    const source = await writeBuild("app.apk", 100);
    limits = { ...limits, publicBaseUrl: null };
    await expect(
      createStore().share({ sourcePath: source, agentId: null, platform: "android" }),
    ).rejects.toThrow(/no https app.baseUrl/);
  });

  test("refuses when the file at the path is no longer the one validated", async () => {
    const source = await writeBuild("app.apk", 100);
    const stat = await fs.stat(source);
    await expect(
      createStore().share({
        sourcePath: source,
        identity: { dev: stat.dev, ino: stat.ino + 1 },
        agentId: null,
        platform: "android",
      }),
    ).rejects.toThrow(/changed while it was being shared/);
  });

  test("a refusal from the finishing step leaves no share behind", async () => {
    const source = await writeBuild("app.ipa", 100);
    await expect(
      createStore().share({
        sourcePath: source,
        agentId: null,
        platform: "ios",
        finish: async () => {
          throw new SharedBuildRefusal("no Info.plist");
        },
      }),
    ).rejects.toThrow(/no Info.plist/);
    expect(await fs.readdir(root)).toEqual([]);
  });

  test("records the app metadata the finishing step returns", async () => {
    const source = await writeBuild("app.ipa", 100);
    const shared = await createStore().share({
      sourcePath: source,
      agentId: null,
      platform: "ios",
      finish: async ({ directory, fileName, urls }) => {
        await fs.writeFile(path.join(directory, "index.html"), urls.file);
        expect(fileName).toBe("app.ipa");
        return { name: "Fake App", version: "1.2.3", build: "45", identifier: "com.example.fake" };
      },
    });
    expect(shared.record.app).toEqual({
      name: "Fake App",
      version: "1.2.3",
      build: "45",
      identifier: "com.example.fake",
    });
    const page = await fs.readFile(path.join(root, shared.record.token, "index.html"), "utf8");
    expect(page).toBe(shared.urls.file);
  });
});

describe("SharedBuildStore.sweep", () => {
  test("deletes expired shares and keeps live ones", async () => {
    const store = createStore();
    const old = await store.share({
      sourcePath: await writeBuild("old.apk", 100),
      agentId: null,
      platform: "android",
    });
    nowMs += 48 * HOUR_MS;
    const fresh = await store.share({
      sourcePath: await writeBuild("fresh.apk", 100),
      agentId: null,
      platform: "android",
    });
    nowMs += 25 * HOUR_MS;

    expect(await store.sweep()).toEqual({ expired: 1, evicted: 0, partial: 0 });
    expect(await liveTokens()).toEqual([fresh.record.token]);
    expect(await liveTokens()).not.toContain(old.record.token);
  });

  test("evicts the oldest shares to fit a new one under the total cap", async () => {
    const store = createStore();
    const tokens: string[] = [];
    for (const name of ["a.apk", "b.apk", "c.apk"]) {
      const shared = await store.share({
        sourcePath: await writeBuild(name, 3000),
        agentId: null,
        platform: "android",
      });
      tokens.push(shared.record.token);
      nowMs += 1000;
    }
    const newest = await store.share({
      sourcePath: await writeBuild("d.apk", 3000),
      agentId: null,
      platform: "android",
    });
    expect(await liveTokens()).toEqual([tokens[1], tokens[2], newest.record.token].sort());
  });

  test("evicts oldest-first when the cap is lowered", async () => {
    const store = createStore();
    const first = await store.share({
      sourcePath: await writeBuild("a.apk", 3000),
      agentId: null,
      platform: "android",
    });
    nowMs += 1000;
    const second = await store.share({
      sourcePath: await writeBuild("b.apk", 3000),
      agentId: null,
      platform: "android",
    });
    limits = { ...limits, maxTotalBytes: 4000 };
    expect(await store.sweep()).toEqual({ expired: 0, evicted: 1, partial: 0 });
    expect(await liveTokens()).toEqual([second.record.token]);
    expect(await liveTokens()).not.toContain(first.record.token);
  });

  test("cleans up what a crash left half-written and leaves other files alone", async () => {
    await fs.mkdir(path.join(root, ".tmp-AAAAAAAAAAAAAAAAAAAAAA"));
    await fs.writeFile(path.join(root, ".tmp-AAAAAAAAAAAAAAAAAAAAAA", "app.apk"), "partial");
    await fs.mkdir(path.join(root, "BBBBBBBBBBBBBBBBBBBBBB"));
    await fs.writeFile(path.join(root, "BBBBBBBBBBBBBBBBBBBBBB", "app.apk"), "no record");
    await fs.mkdir(path.join(root, "CCCCCCCCCCCCCCCCCCCCCC"));
    await fs.writeFile(path.join(root, "CCCCCCCCCCCCCCCCCCCCCC", SHARE_RECORD_FILE), "{not json");
    await fs.writeFile(path.join(root, "README.txt"), "someone else's");

    expect(await createStore().sweep()).toEqual({ expired: 0, evicted: 0, partial: 3 });
    expect(await fs.readdir(root)).toEqual(["README.txt"]);
  });

  test("a missing root is an empty sweep", async () => {
    root = path.join(workDir, "never-created");
    expect(await createStore().sweep()).toEqual({ expired: 0, evicted: 0, partial: 0 });
  });
});

describe("resolveSharedBuildsConfig", () => {
  test("defaults: on, 600 MB per file, 3 GB total, 3 days, app.baseUrl as the public site", () => {
    expect(resolveSharedBuildsConfig({ app: { baseUrl: "https://shares.example.com/" } })).toEqual({
      enabled: true,
      maxFileBytes: 600 * 1024 * 1024,
      maxTotalBytes: 3072 * 1024 * 1024,
      expiryMs: 72 * HOUR_MS,
      publicBaseUrl: "https://shares.example.com",
    });
  });

  test("reads agents.sharedBuilds", () => {
    expect(
      resolveSharedBuildsConfig({
        app: { baseUrl: "https://shares.example.com" },
        agents: { sharedBuilds: { enabled: false, maxFileMb: 10, maxTotalMb: 20, expiryHours: 1 } },
      }),
    ).toEqual({
      enabled: false,
      maxFileBytes: 10 * 1024 * 1024,
      maxTotalBytes: 20 * 1024 * 1024,
      expiryMs: HOUR_MS,
      publicBaseUrl: "https://shares.example.com",
    });
  });

  test("a missing or non-https app.baseUrl has no public site", () => {
    expect(resolveSharedBuildsConfig(null).publicBaseUrl).toBeNull();
    expect(
      resolveSharedBuildsConfig({ app: { baseUrl: "http://shares.example.com" } }).publicBaseUrl,
    ).toBeNull();
    expect(resolveSharedBuildsConfig({ app: { baseUrl: "not a url" } }).publicBaseUrl).toBeNull();
  });
});
