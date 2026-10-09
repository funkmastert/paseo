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
import type { PushNotificationSender } from "../../push/index.js";
import { finishAndroidShare } from "../../shared-builds/android-manifest.js";
import { finishIosShare } from "../../shared-builds/ios-manifest.js";
import {
  SharedBuildRefusal,
  type SharedBuild,
  type SharedBuildFinishInput,
  type SharedBuildPlatform,
  type SharedBuildStore,
} from "../../shared-builds/shared-build-store.js";
import { runJevGit, samePathOrBelow, type JevGitRunner } from "./jev-file-state.js";
import type { PaseoToolConfig, PaseoToolExecutionContext, PaseoToolResult } from "./types.js";

export interface SharedBuildsToolDependencies {
  store: Pick<SharedBuildStore, "share" | "unavailableReason">;
  /** Resolved per call: the sender exists only once the WebSocket server does. */
  getPushNotificationSender: () => PushNotificationSender | null;
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
  logger: Logger;
}

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
  "Refused while free disk is low, and over the size caps; older shares are deleted to make room.",
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

/** The caller's cwd, and its git worktree when that isn't the home directory or above it. */
async function resolveAllowedRoots(input: {
  cwd: string;
  runGit: JevGitRunner;
  platform: NodeJS.Platform;
  homeDir: string;
}): Promise<string[] | null> {
  const realCwd = await realpathOrNull(input.cwd);
  if (!realCwd) return null;
  const roots = [realCwd];
  const top = await input.runGit(["rev-parse", "--show-toplevel"], { cwd: realCwd });
  const realTop =
    top.code === 0 && top.stdout.trim() ? await realpathOrNull(top.stdout.trim()) : null;
  const realHome = (await realpathOrNull(input.homeDir)) ?? input.homeDir;
  if (
    realTop &&
    realTop !== path.parse(realTop).root &&
    !samePathOrBelow(realTop, realHome, input.platform)
  ) {
    roots.push(realTop);
  }
  return roots;
}

async function validateBuildPath(input: {
  requested: string;
  cwd: string;
  runGit: JevGitRunner;
  platform: NodeJS.Platform;
  homeDir: string;
}): Promise<ValidatedBuild | { refusal: string }> {
  const shown = input.requested.trim();
  if (!shown || shown.includes("\0")) return { refusal: "That is not a path." };
  const roots = await resolveAllowedRoots(input);
  if (!roots) return { refusal: "Your working directory does not exist." };
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

export function registerShareBuildTools(options: RegisterShareBuildToolsOptions): void {
  const { deps, callerAgentId, logger } = options;
  const runGit = options.runGit ?? runJevGit;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();

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
      if (!callerAgentId) {
        return toResult(
          { error: "share_build needs to know which agent is asking, and this session has none." },
          true,
        );
      }
      const unavailable = deps.store.unavailableReason();
      if (unavailable) return toResult({ error: unavailable }, true);
      const caller = await options.readCaller();
      if (!caller) return toResult({ error: "Your agent record could not be read." }, true);

      const validated = await validateBuildPath({
        requested: input.path,
        cwd: caller.cwd,
        runGit,
        platform,
        homeDir,
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
      let pushOutcome = "sent";
      const sender = deps.getPushNotificationSender();
      if (!sender) {
        pushOutcome = "not sent: this daemon has no push sender";
      } else {
        try {
          await sender.send(
            {
              ...push,
              data: {
                serverId: deps.serverId,
                agentId: callerAgentId,
                ...(caller.workspaceId ? { workspaceId: caller.workspaceId } : {}),
                externalUrl: url,
              },
            },
            // Needs Tyler soon, and nothing is lost if he waits. One build pushed once an hour.
            { level: "alert", dedupeKey: `shared-build:${shared.record.sha256}` },
          );
        } catch (error) {
          pushOutcome = `not sent: ${error instanceof Error ? error.message : String(error)}`;
          logger.warn({ err: error, agentId: callerAgentId }, "Shared build push failed");
        }
      }
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
