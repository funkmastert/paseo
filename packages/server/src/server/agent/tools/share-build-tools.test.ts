import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  createPushNotifications,
  type PushNotifications,
  type PushPayload,
  type PushSendMeta,
} from "../../push/index.js";
import {
  SharedBuildStore,
  type SharedBuildsLimits,
} from "../../shared-builds/shared-build-store.js";
import {
  buildAndroidManifest,
  buildBinaryPlist,
  buildFakeApk,
  buildFakeIpa,
} from "../../shared-builds/test-utils/fake-archives.js";
import type { JevGitRunner } from "./jev-file-state.js";
import { registerShareBuildTools, type ShareBuildCaller } from "./share-build-tools.js";
import type { PaseoToolConfig, PaseoToolExecutionContext, PaseoToolResult } from "./types.js";

type Handler = (input: unknown, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>;

const BASE_URL = "https://shares.example.com";
const GIB = 1024 * 1024 * 1024;

let sandbox: string;
let cwd: string;
let root: string;
let limits: SharedBuildsLimits;
let pushes: Array<{ payload: PushPayload; meta: PushSendMeta | undefined }>;
let caller: ShareBuildCaller | null;
let gitTop: string | null;
let hasSender: boolean;
let homeDir: string;
let worktreesRoot: string;

const noGit: JevGitRunner = async () => ({
  code: gitTop ? 0 : 128,
  stdout: gitTop ? `${gitTop}\n` : "",
  stderr: "",
});

interface SetupOptions {
  callerAgentId?: string;
  /** A real push stack, so the notify policy decides what reaches the phone. */
  push?: PushNotifications;
}

function setup(options: SetupOptions = { callerAgentId: "agent-1" }): Handler {
  const realPush = options.push;
  const store = new SharedBuildStore({
    root,
    readLimits: () => limits,
    readFreeBytes: async () => 100 * GIB,
    logger: createTestLogger(),
  });
  const handlers = new Map<string, Handler>();
  registerShareBuildTools({
    registerTool: (name: string, _config: PaseoToolConfig, handler: Handler) => {
      handlers.set(name, handler);
    },
    deps: {
      store,
      getPushNotificationSender: () => {
        if (realPush) return realPush;
        return hasSender
          ? {
              send: async (payload, meta) => {
                pushes.push({ payload, meta });
              },
            }
          : null;
      },
      previewPush: (meta) =>
        realPush ? realPush.policy.previewDelivery(meta) : { outcome: "interrupt", devices: 1 },
      serverId: "server-1",
    },
    callerAgentId: options.callerAgentId,
    readCaller: async () => caller,
    runGit: noGit,
    homeDir,
    paseoHome: path.join(sandbox, "paseo-home"),
    worktreesRoot,
    logger: createTestLogger(),
  });
  const handler = handlers.get("share_build");
  if (!handler) throw new Error("share_build was not registered");
  return handler;
}

/** What the store root holds; nothing when it was never created. */
async function sharesOnDisk(): Promise<string[]> {
  return fs.readdir(root).catch(() => []);
}

function parse(result: PaseoToolResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

async function writeFile(relative: string, contents: Buffer | string): Promise<string> {
  const file = path.join(cwd, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
  return file;
}

function fakeApk(): Buffer {
  return buildFakeApk(
    buildAndroidManifest({
      packageName: "com.example.fakecamp.debug",
      versionName: "2.3.0",
      versionCode: 230,
    }),
  );
}

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(path.join(os.tmpdir(), "share-build-tool-")));
  cwd = path.join(sandbox, "worktree");
  root = path.join(sandbox, "shares");
  limits = {
    enabled: true,
    maxFileBytes: 1024 * 1024,
    maxTotalBytes: 10 * 1024 * 1024,
    expiryMs: 72 * 60 * 60 * 1000,
    publicBaseUrl: BASE_URL,
    lowFreeBytes: 20 * GIB,
  };
  pushes = [];
  caller = { cwd, title: "Fix login bug", workspaceId: "workspace-1" };
  gitTop = null;
  hasSender = true;
  homeDir = path.join(os.tmpdir(), "share-build-tool-no-such-home");
  worktreesRoot = path.join(sandbox, "worktrees-root");
});

/** The daemon's own push stack over a temp directory, delivering to a list instead of Expo. */
function realPushStack(input: { devices: number; settings?: Record<string, unknown> }): {
  push: PushNotifications;
  delivered: string[];
} {
  const directory = path.join(sandbox, "push");
  mkdirSync(directory, { recursive: true });
  if (input.settings) {
    writeFileSync(
      path.join(directory, "notify-policy.json"),
      JSON.stringify({ settings: input.settings }),
    );
  }
  const delivered: string[] = [];
  const push = createPushNotifications({
    logger: createTestLogger(),
    filePath: path.join(directory, "push-tokens.json"),
    deliver: async (_tokens, payload) => {
      delivered.push(payload.title);
    },
  });
  for (let i = 0; i < input.devices; i += 1) push.renew(`ExponentPushToken[fake-${i}]`);
  return { push, delivered };
}

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("share_build", () => {
  test("shares an APK under the cwd, returns its link and pushes it once", async () => {
    await writeFile("app/build/outputs/apk/debug/app-debug.apk", fakeApk());
    const result = await setup()(
      { path: "app/build/outputs/apk/debug/app-debug.apk", note: "Login works again." },
      {},
    );

    expect(result.isError).toBeUndefined();
    const payload = parse(result);
    const url = payload["url"] as string;
    expect(url).toMatch(/^https:\/\/shares\.example\.com\/b\/[A-Za-z0-9_-]{22}\/app-debug\.apk$/);
    expect(payload).toMatchObject({
      platform: "android",
      push: { outcome: "sent" },
      app: { identifier: "com.example.fakecamp.debug", version: "2.3.0", build: "230" },
    });

    expect(pushes).toHaveLength(1);
    const [{ payload: push, meta }] = pushes;
    expect(push.title).toBe("Android build ready");
    expect(push.body).toBe(
      "com.example.fakecamp.debug 2.3.0 from Fix login bug. Tap to install. Login works again.",
    );
    expect(push.data).toEqual({
      serverId: "server-1",
      agentId: "agent-1",
      workspaceId: "workspace-1",
      externalUrl: url,
    });
    expect(meta?.level).toBe("alert");
    expect(meta?.dedupeKey).toMatch(/^shared-build:[0-9a-f]{64}$/);
    expect(payload["tylerSees"]).toEqual({ title: push.title, body: push.body });

    const token = url.split("/")[4];
    const copied = await fs.readFile(path.join(root, token, "app-debug.apk"));
    expect(copied.equals(fakeApk())).toBe(true);
  });

  test("an agent-given app name replaces the package name in the push", async () => {
    await writeFile("app-debug.apk", fakeApk());
    await setup()({ path: path.join(cwd, "app-debug.apk"), appName: "Fake Camp" }, {});
    expect(pushes[0].payload.body).toBe("Fake Camp 2.3.0 from Fix login bug. Tap to install.");
  });

  test("an IPA is shared as its install page", async () => {
    await writeFile(
      "build/export/Fake.ipa",
      buildFakeIpa(
        buildBinaryPlist({
          CFBundleIdentifier: "com.example.fakecamp",
          CFBundleShortVersionString: "1.4.0",
          CFBundleVersion: "812",
          CFBundleDisplayName: "Fake Camp",
        }),
      ),
    );
    const result = await setup()({ path: "build/export/Fake.ipa" }, {});
    const payload = parse(result);
    const url = payload["url"] as string;
    expect(url).toMatch(/^https:\/\/shares\.example\.com\/b\/[A-Za-z0-9_-]{22}\/$/);
    expect(payload["platform"]).toBe("ios");
    expect(pushes[0].payload.title).toBe("iPhone build ready");
    expect(pushes[0].payload.body).toBe("Fake Camp 1.4.0 from Fix login bug. Tap to install.");
    expect(pushes[0].payload.data?.["externalUrl"]).toBe(url);
    const token = url.split("/")[4];
    expect((await fs.readdir(path.join(root, token))).sort()).toEqual([
      "Fake.ipa",
      "index.html",
      "manifest.plist",
      "share.json",
    ]);
  });

  test("a build in the cwd's git worktree, outside the cwd, is shared", async () => {
    gitTop = sandbox;
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(sandbox, "app-debug.apk"), fakeApk());
    const result = await setup()({ path: "../app-debug.apk" }, {});
    expect(result.isError).toBeUndefined();
  });

  test("a git worktree that is the home directory doesn't widen the cwd", async () => {
    homeDir = path.join(sandbox, "home");
    gitTop = homeDir;
    caller = { cwd: path.join(homeDir, "project"), title: null, workspaceId: null };
    await fs.mkdir(caller.cwd, { recursive: true });
    await fs.writeFile(path.join(homeDir, "app-debug.apk"), fakeApk());
    const result = await setup()({ path: "../app-debug.apk" }, {});
    expect(result.isError).toBe(true);
    expect(parse(result)["error"]).toMatch(/outside your working directory/);
  });

  test.each([
    [
      "a path outside the cwd",
      async () => path.join(sandbox, "elsewhere.apk"),
      /outside your working directory/,
    ],
    [
      "a symlink out of the cwd",
      async () => {
        await fs.writeFile(path.join(sandbox, "secret.apk"), fakeApk());
        await fs.mkdir(cwd, { recursive: true });
        await fs.symlink(path.join(sandbox, "secret.apk"), path.join(cwd, "link.apk"));
        return "link.apk";
      },
      /outside your working directory/,
    ],
    [
      "a symlink to a non-build file in the cwd",
      async () => {
        await writeFile("notes.txt", "hello");
        await fs.symlink(path.join(cwd, "notes.txt"), path.join(cwd, "notes.apk"));
        return "notes.apk";
      },
      /Only an .apk or an .ipa/,
    ],
    [
      "a directory",
      async () => {
        await fs.mkdir(path.join(cwd, "folder.apk"), { recursive: true });
        return "folder.apk";
      },
      /is not a file/,
    ],
    [
      "a .zip",
      async () => {
        await writeFile("build.zip", fakeApk());
        return "build.zip";
      },
      /Only an .apk or an .ipa/,
    ],
    [
      "a hard link",
      async () => {
        await writeFile("app-debug.apk", fakeApk());
        await fs.link(path.join(cwd, "app-debug.apk"), path.join(cwd, "copy.apk"));
        return "copy.apk";
      },
      /hard link/,
    ],
    [
      "a missing file",
      async () => {
        await fs.mkdir(cwd, { recursive: true });
        return "nope.apk";
      },
      /was not found/,
    ],
  ])("refuses %s", async (_label, makePath, message) => {
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(sandbox, "elsewhere.apk"), fakeApk());
    const result = await setup()({ path: await makePath() }, {});
    expect(result.isError).toBe(true);
    expect(parse(result)["error"]).toMatch(message);
    expect(pushes).toEqual([]);
    expect(await fs.readdir(root).catch(() => [])).toEqual([]);
  });

  test("refuses an APK that isn't one, and pushes nothing", async () => {
    await writeFile("app-release.apk", "not a zip at all, just text pretending");
    const result = await setup()({ path: "app-release.apk" }, {});
    expect(result.isError).toBe(true);
    expect(parse(result)["error"]).toMatch(/not an installable APK/);
    expect(pushes).toEqual([]);
  });

  test("refuses with a message when the feature is off", async () => {
    limits = { ...limits, enabled: false };
    await writeFile("app-debug.apk", fakeApk());
    const result = await setup()({ path: "app-debug.apk" }, {});
    expect(result.isError).toBe(true);
    expect(parse(result)["error"]).toMatch(/turned off/);
  });

  test("is not offered without a caller agent", () => {
    expect(() => setup({})).toThrow(/not registered/);
  });

  test("still returns the link when there is no push sender", async () => {
    hasSender = false;
    await writeFile("app-debug.apk", fakeApk());
    const payload = parse(await setup()({ path: "app-debug.apk" }, {}));
    expect(payload["url"]).toMatch(/app-debug\.apk$/);
    expect(payload["push"]).toMatchObject({ outcome: "no-sender" });
  });

  describe("confinement root", () => {
    test.each([
      ["the home directory", () => homeDir],
      ["an ancestor of the home directory", () => path.dirname(homeDir)],
      ["the filesystem root", () => path.parse(sandbox).root],
      ["the worktrees root", () => worktreesRoot],
    ])("refuses a cwd that is %s", async (_label, cwdOf) => {
      homeDir = path.join(sandbox, "home");
      await fs.mkdir(homeDir, { recursive: true });
      await fs.mkdir(worktreesRoot, { recursive: true });
      const apk = path.join(homeDir, "app-debug.apk");
      await fs.writeFile(apk, fakeApk());
      await fs.writeFile(path.join(worktreesRoot, "app-debug.apk"), fakeApk());
      caller = { cwd: cwdOf(), title: null, workspaceId: null };
      const result = await setup()({ path: apk }, {});
      expect(result.isError).toBe(true);
      expect(parse(result)["error"]).toMatch(/run it from the project/);
      expect(await sharesOnDisk()).toEqual([]);
    });

    test("a worktree under the worktrees root is a fine cwd", async () => {
      cwd = path.join(worktreesRoot, "project", "branch");
      caller = { cwd, title: null, workspaceId: null };
      await writeFile("app-debug.apk", fakeApk());
      const result = await setup()({ path: "app-debug.apk" }, {});
      expect(result.isError).toBeUndefined();
    });
  });

  describe("push outcome", () => {
    test("sent when the push goes to a phone now", async () => {
      const { push, delivered } = realPushStack({ devices: 1 });
      await writeFile("app-debug.apk", fakeApk());
      const payload = parse(
        await setup({ callerAgentId: "agent-1", push })({ path: "app-debug.apk" }, {}),
      );
      expect(payload["push"]).toMatchObject({ outcome: "sent" });
      expect(delivered).toEqual(["Android build ready"]);
    });

    test("folded when the same build was pushed within the hour", async () => {
      const { push, delivered } = realPushStack({ devices: 1 });
      await writeFile("app-debug.apk", fakeApk());
      const tool = setup({ callerAgentId: "agent-1", push });
      await tool({ path: "app-debug.apk" }, {});
      const second = parse(await tool({ path: "app-debug.apk", note: "Again." }, {}));
      expect(second["push"]).toMatchObject({ outcome: "folded" });
      expect(second["url"]).toMatch(/app-debug\.apk$/);
      expect(delivered).toEqual(["Android build ready"]);
    });

    test("no-device when no phone is registered", async () => {
      const { push, delivered } = realPushStack({ devices: 0 });
      await writeFile("app-debug.apk", fakeApk());
      const payload = parse(
        await setup({ callerAgentId: "agent-1", push })({ path: "app-debug.apk" }, {}),
      );
      expect(payload["push"]).toMatchObject({ outcome: "no-device" });
      expect(delivered).toEqual([]);
    });

    test("digest when alerts wait for the digest", async () => {
      const { push, delivered } = realPushStack({
        devices: 1,
        settings: { minInterruptLevel: "urgent" },
      });
      await writeFile("app-debug.apk", fakeApk());
      const payload = parse(
        await setup({ callerAgentId: "agent-1", push })({ path: "app-debug.apk" }, {}),
      );
      expect(payload["push"]).toMatchObject({ outcome: "digest" });
      expect(delivered).toEqual([]);
    });

    test("logged when alerts are only recorded", async () => {
      const { push, delivered } = realPushStack({
        devices: 1,
        settings: { minPostLevel: "urgent", minInterruptLevel: "urgent" },
      });
      await writeFile("app-debug.apk", fakeApk());
      const payload = parse(
        await setup({ callerAgentId: "agent-1", push })({ path: "app-debug.apk" }, {}),
      );
      expect(payload["push"]).toMatchObject({ outcome: "logged" });
      expect(delivered).toEqual([]);
    });

    test("failed when the sender throws", async () => {
      await writeFile("app-debug.apk", fakeApk());
      const failing = {
        send: async () => {
          throw new Error("ledger is read-only");
        },
      } as unknown as PushNotifications;
      const payload = parse(
        await setup({ callerAgentId: "agent-1", push: failing })({ path: "app-debug.apk" }, {}),
      );
      expect(payload["push"]).toMatchObject({ outcome: "failed" });
    });
  });
});
