/**
 * `share_build`: an agent hands a mobile build it made to Tyler's phone (docs/shared-builds.md).
 * The daemon copies it behind an unguessable, expiring link on the public static site and pushes
 * Tyler a notification whose tap opens the link: the APK downloads, or the iOS install page opens.
 *
 * The path is confined the way the JEV file tools confine theirs (jev-file-state.ts): resolved,
 * realpathed, inside the caller's cwd or its git worktree, a regular file with one link.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { resolvePathFromBase } from "../../path-utils.js";
import type { NotifyDeliveryPreview, NotifyPolicy } from "../../notify-policy/notify-policy.js";
import type { PushNotificationSender, PushPayload } from "../../push/index.js";
import { finishAndroidShare } from "../../shared-builds/android-manifest.js";
import { finishIosShare } from "../../shared-builds/ios-manifest.js";
import {
  SharedBuildRefusal,
  type SharedBuild,
  type SharedBuildFinishInput,
  type SharedBuildPlatform,
  type SharedBuildStore,
} from "../../shared-builds/shared-build-store.js";
import {
  canonicalJevPath,
  resolveWorktreeRoots,
  runJevGit,
  samePathOrBelow,
  type JevGitRunner,
} from "./jev-file-state.js";
import type { PaseoToolConfig, PaseoToolExecutionContext, PaseoToolResult } from "./types.js";

export interface SharedBuildsToolDependencies {
  store: Pick<SharedBuildStore, "share" | "unavailableReason">;
  /** Resolved per call: the sender exists only once the WebSocket server does. */
  getPushNotificationSender: () => PushNotificationSender | null;
  /**
   * What the notify policy would do with the push right now (bootstrap wires the daemon's own
   * policy). Absent or throwing: the tool says the outcome is unconfirmed.
   */
  previewPush?: (meta: Parameters<NotifyPolicy["previewDelivery"]>[0]) => NotifyDeliveryPreview;
  serverId: string;
}

export interface ShareBuildCaller {
  cwd: string;
  title: string | null;
  workspaceId: string | null;
}

export interface RegisterShareBuildToolsOptions {
  registerTool: (
    name: string,
    config: PaseoToolConfig,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tool inputs are validated by the catalog before execution.
    handler: (input: any, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>,
  ) => void;
  deps: SharedBuildsToolDependencies;
  callerAgentId?: string;
  /** The caller as it is now, so a cwd change after the catalog was built is honored. */
  readCaller: () => Promise<ShareBuildCaller | null>;
  runGit?: JevGitRunner;
  platform?: NodeJS.Platform;
  homeDir?: string;
  /** With `worktreesRoot`, where the worktrees root is: a cwd that is that root is refused. */
  paseoHome?: string;
  worktreesRoot?: string;
  logger: Logger;
}

interface RootContext {
  runGit: JevGitRunner;
  platform: NodeJS.Platform;
  homeDir: string;
  paseoHome?: string;
  worktreesRoot?: string;
}

/** What happened to the push, for the agent to relay. Anything but `sent` means Tyler wasn't told. */
export type SharePushOutcome =
  | "sent"
  | "folded"
  | "digest"
  | "logged"
  | "no-device"
  | "no-sender"
  | "failed"
  | "unconfirmed";

interface ValidatedBuild {
  realPath: string;
  platform: SharedBuildPlatform;
  identity: { dev: number; ino: number };
}

const EXTENSIONS: Record<string, SharedBuildPlatform> = { ".apk": "android", ".ipa": "ios" };

const DESCRIPTION = [
  "Send a mobile build you made to Tyler's phone. The daemon hosts the file behind an unguessable https link that expires after a few days, and pushes Tyler a notification; tapping it downloads the APK or opens the iPhone install page. Returns the link, its expiry and the push Tyler sees.",
  "Share only a build you produced for Tyler to try, from inside your working directory or its git worktree.",
  "Android: build a debug APK (`./gradlew :app:assembleDebug`) and share app/build/outputs/apk/debug/app-debug.apk. An AAB can't be installed this way.",
  "iPhone: export an ad-hoc IPA. Archive with `xcodebuild archive`, then `xcodebuild -exportArchive -exportOptionsPlist <plist>` with `method` set to `release-testing` (`ad-hoc` on Xcode before 15.3). Keep that export-options plist outside the repo, in a temp dir. It installs only on an iPhone registered on the ad-hoc provisioning profile.",
  "Caps, by default: 600 MB per build, 3 GB across all shares (the oldest are deleted to make room), links expire after 3 days. Refused while free disk is low.",
].join("\n\n");

function toResult(payload: unknown, isError = false): PaseoToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
}

const TOO_BROAD_REFUSAL =
  "share_build does not share from your home directory, an ancestor of it, the filesystem root or the worktrees root; run it from the project that built the file.";

/**
 * Whether a directory is too broad to confine a share to: the filesystem root, the home directory
 * or an ancestor of it, or the worktrees root, which holds every agent's worktree. The same
 * directories JevFileScope.open refuses as a cwd.
 */
function isTooBroadRoot(
  root: string,
  broad: { realHome: string; homeDir: string; worktreeRoots: string[]; platform: NodeJS.Platform },
): boolean {
  const { platform } = broad;
  const canonical = canonicalJevPath(root, platform);
  return (
    canonical === canonicalJevPath(path.parse(root).root, platform) ||
    samePathOrBelow(root, broad.realHome, platform) ||
    samePathOrBelow(root, broad.homeDir, platform) ||
    broad.worktreeRoots.some((worktrees) => canonical === canonicalJevPath(worktrees, platform))
  );
}

/** The caller's cwd, and its git worktree when that isn't too broad either. */
async function resolveAllowedRoots(
  input: RootContext & { cwd: string },
): Promise<string[] | { refusal: string }> {
  const realCwd = await realpathOrNull(input.cwd);
  if (!realCwd) return { refusal: "Your working directory does not exist." };
  const broad = {
    realHome: (await realpathOrNull(input.homeDir)) ?? input.homeDir,
    homeDir: input.homeDir,
    worktreeRoots: input.paseoHome
      ? await resolveWorktreeRoots(input.paseoHome, input.worktreesRoot, input.platform)
      : [],
    platform: input.platform,
  };
  if (isTooBroadRoot(realCwd, broad)) return { refusal: TOO_BROAD_REFUSAL };
  const roots = [realCwd];
  const top = await input.runGit(["rev-parse", "--show-toplevel"], { cwd: realCwd });
  const realTop =
    top.code === 0 && top.stdout.trim() ? await realpathOrNull(top.stdout.trim()) : null;
  if (realTop && !isTooBroadRoot(realTop, broad)) roots.push(realTop);
  return roots;
}

async function validateBuildPath(
  input: RootContext & { requested: string; cwd: string },
): Promise<ValidatedBuild | { refusal: string }> {
  const shown = input.requested.trim();
  if (!shown || shown.includes("\0")) return { refusal: "That is not a path." };
  const roots = await resolveAllowedRoots(input);
  if ("refusal" in roots) return roots;
  const realPath = await realpathOrNull(resolvePathFromBase(input.cwd, shown));
  if (!realPath) return { refusal: `${shown} was not found.` };
  if (!roots.some((root) => samePathOrBelow(root, realPath, input.platform))) {
    return {
      refusal: `${shown} is outside your working directory and its git worktree; only a build you made there can be shared.`,
    };
  }
  const platform = EXTENSIONS[path.extname(realPath).toLowerCase()];
  if (!platform) return { refusal: "Only an .apk or an .ipa file can be shared." };
  const stat = await fs.stat(realPath).catch(() => null);
  if (!stat) return { refusal: `${shown} was not found.` };
  if (!stat.isFile()) return { refusal: `${shown} is not a file.` };
  // A hard link's real path is inside cwd whatever its other name is: it could be anything.
  if (stat.nlink > 1)
    return { refusal: `${shown} is a hard link; share the file it was built as.` };
  return { realPath, platform, identity: { dev: stat.dev, ino: stat.ino } };
}

function platformLabel(platform: SharedBuildPlatform): string {
  return platform === "ios" ? "iPhone" : "Android";
}

function describeApp(shared: SharedBuild, appName: string | undefined): string {
  const { app, fileName } = shared.record;
  const name = app.name ?? appName ?? app.identifier ?? fileName;
  return app.version ? `${name} ${app.version}` : name;
}

export function buildShareBuildPush(input: {
  shared: SharedBuild;
  appName?: string;
  note?: string;
  agentTitle: string | null;
}): { title: string; body: string } {
  const { shared } = input;
  const from = input.agentTitle ? ` from ${input.agentTitle}` : "";
  const note = input.note ? ` ${input.note}` : "";
  return {
    title: `${platformLabel(shared.record.platform)} build ready`,
    body: `${describeApp(shared, input.appName)}${from}. Tap to install.${note}`,
  };
}

/** The notify policy's verdict, as the outcome the agent reports to Tyler. */
function describePushOutcome(preview: NotifyDeliveryPreview | null): {
  outcome: SharePushOutcome;
  detail: string;
} {
  const tellTyler = "Give Tyler the link yourself.";
  if (!preview) {
    return {
      outcome: "unconfirmed",
      detail: "Handed to the push sender; whether it reached the phone is unknown.",
    };
  }
  switch (preview.outcome) {
    case "suppressed":
      return {
        outcome: "folded",
        detail: `Not pushed again: this same build was pushed within the last hour, and the new link was not. ${tellTyler}`,
      };
    case "log":
      return {
        outcome: "logged",
        detail: `Not pushed: the notification settings only record alerts. ${tellTyler}`,
      };
    case "digest":
      return {
        outcome: "digest",
        detail: `Held for the next notice digest, not pushed now; a digest of several notices drops the tap-to-install link. ${tellTyler}`,
      };
    default:
      if (preview.devices === 0) {
        return {
          outcome: "no-device",
          detail: `Not pushed: no phone is registered for notifications. ${tellTyler}`,
        };
      }
      return {
        outcome: "sent",
        detail:
          preview.outcome === "notify"
            ? "Pushed to Tyler's phone without a sound (his notifications are in focus or off mode)."
            : "Pushed to Tyler's phone.",
      };
  }
}

/** Sends the push and says what became of it. */
async function sendSharePush(input: {
  deps: SharedBuildsToolDependencies;
  payload: PushPayload;
  sha256: string;
  agentId: string;
  logger: Logger;
}): Promise<{ outcome: SharePushOutcome; detail: string }> {
  const { deps } = input;
  const sender = deps.getPushNotificationSender();
  if (!sender) {
    return {
      outcome: "no-sender",
      detail: "This daemon has no push sender. Give Tyler the link yourself.",
    };
  }
  // Needs Tyler soon, and nothing is lost if he waits. One build pushed once an hour.
  const meta = { level: "alert", dedupeKey: `shared-build:${input.sha256}` } as const;
  // Asked before sending: after, the policy would see this push as its own repeat.
  let preview: NotifyDeliveryPreview | null = null;
  try {
    preview = deps.previewPush?.(meta) ?? null;
  } catch {
    preview = null;
  }
  try {
    await sender.send(input.payload, meta);
  } catch (error) {
    input.logger.warn({ err: error, agentId: input.agentId }, "Shared build push failed");
    const message = error instanceof Error ? error.message : String(error);
    return {
      outcome: "failed",
      detail: `The push failed: ${message}. Give Tyler the link yourself.`,
    };
  }
  return describePushOutcome(preview);
}

export function registerShareBuildTools(options: RegisterShareBuildToolsOptions): void {
  const { deps, callerAgentId, logger } = options;
  // Every share is the caller's: without one there is no cwd to confine it to.
  if (!callerAgentId) return;
  const roots: RootContext = {
    runGit: options.runGit ?? runJevGit,
    platform: options.platform ?? process.platform,
    homeDir: options.homeDir ?? os.homedir(),
    ...(options.paseoHome ? { paseoHome: options.paseoHome } : {}),
    ...(options.worktreesRoot ? { worktreesRoot: options.worktreesRoot } : {}),
  };

  options.registerTool(
    "share_build",
    {
      title: "Share a build to Tyler's phone",
      description: DESCRIPTION,
      inputSchema: {
        path: z
          .string()
          .trim()
          .min(1)
          .describe(
            "The .apk or .ipa to share: absolute, or relative to your working directory, and inside it or its git worktree.",
          ),
        appName: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .optional()
          .describe(
            "The app's name for the push. An IPA carries its own; an APK otherwise shows its package name.",
          ),
        note: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("One line for Tyler, such as what changed in this build. Shown in the push."),
      },
    },
    async (input: { path: string; appName?: string; note?: string }) => {
      const unavailable = deps.store.unavailableReason();
      if (unavailable) return toResult({ error: unavailable }, true);
      const caller = await options.readCaller();
      if (!caller) return toResult({ error: "Your agent record could not be read." }, true);

      const validated = await validateBuildPath({
        ...roots,
        requested: input.path,
        cwd: caller.cwd,
      });
      if ("refusal" in validated) return toResult({ error: validated.refusal }, true);

      let shared: SharedBuild;
      try {
        shared = await deps.store.share({
          sourcePath: validated.realPath,
          identity: validated.identity,
          agentId: callerAgentId,
          platform: validated.platform,
          finish:
            validated.platform === "ios"
              ? finishIosShare
              : async (finishInput: SharedBuildFinishInput) => ({
                  ...(await finishAndroidShare(finishInput)),
                  name: input.appName ?? null,
                }),
        });
      } catch (error) {
        if (error instanceof SharedBuildRefusal) return toResult({ error: error.message }, true);
        throw error;
      }

      const url = shared.record.platform === "ios" ? shared.urls.directory : shared.urls.file;
      const push = buildShareBuildPush({
        shared,
        appName: input.appName,
        note: input.note,
        agentTitle: caller.title,
      });
      const pushOutcome = await sendSharePush({
        deps,
        payload: {
          ...push,
          data: {
            serverId: deps.serverId,
            agentId: callerAgentId,
            ...(caller.workspaceId ? { workspaceId: caller.workspaceId } : {}),
            externalUrl: url,
          },
        },
        sha256: shared.record.sha256,
        agentId: callerAgentId,
        logger,
      });
      logger.info(
        {
          agentId: callerAgentId,
          token: shared.record.token,
          platform: shared.record.platform,
          bytes: shared.record.bytes,
        },
        "Build shared",
      );
      return toResult({
        url,
        platform: shared.record.platform,
        expiresAt: shared.record.expiresAt,
        app: shared.record.app,
        push: pushOutcome,
        tylerSees: push,
        ...(shared.record.platform === "ios"
          ? {
              note: "The link opens an install page; it installs only if the IPA is ad-hoc signed with a profile that lists Tyler's iPhone.",
            }
          : {}),
      });
    },
  );
}
