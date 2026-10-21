import { resolve, win32 } from "node:path";
import { isGitHubHost, parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";
import { getRealpathAwareRelativePath, normalizePathForIdentity } from "../utils/path.js";

/** Persisted opaque key used to join the same remote across hosts. */
export function deriveProjectKey(input: {
  rootPath: string;
  remoteUrl: string | null;
  worktreeRoot: string | null;
  mainRepoRoot: string | null;
  serverId?: string;
}): string {
  const remote = input.remoteUrl ? parseGitRemoteLocation(input.remoteUrl) : null;
  // null: not a worktree subpath at all. "": the worktree root itself, no subdir offset — still
  // a worktree, so the local-path branch below must not treat it the same as null.
  const selectedPath = input.worktreeRoot
    ? getRealpathAwareRelativePath(input.worktreeRoot, input.rootPath)
    : null;
  if (remote) {
    const host = remote.port ? `${remote.host}:${remote.port}` : remote.host;
    const path = isGitHubHost(remote.host) ? remote.path.toLowerCase() : remote.path;
    const remoteKey = `remote:${host}/${path}`;
    return selectedPath ? `${remoteKey}#subdir:${selectedPath.replaceAll("\\", "/")}` : remoteKey;
  }

  const localPathParts: [string, string] =
    selectedPath !== null && input.mainRepoRoot
      ? [input.mainRepoRoot, selectedPath]
      : [input.rootPath, ""];
  const resolvedLocalPath = localPathParts.some(looksLikeWindowsPath)
    ? win32.resolve(...localPathParts)
    : resolve(...localPathParts);
  const localPath = normalizePathForIdentity(resolvedLocalPath);
  return input.serverId ? `host:${input.serverId}:${localPath}` : localPath;
}

export function deriveProjectGroupingDisplayName(input: {
  rootPath: string;
  remoteUrl: string | null;
  worktreeRoot: string | null;
}): string {
  const selectedPath = input.worktreeRoot
    ? getRealpathAwareRelativePath(input.worktreeRoot, input.rootPath)
    : null;
  if (selectedPath) return lastPathSegment(input.rootPath);

  const remote = input.remoteUrl ? parseGitRemoteLocation(input.remoteUrl) : null;
  if (!remote) return lastPathSegment(input.rootPath);
  return remote.path.split("/").filter(Boolean).slice(-2).join("/") || input.rootPath;
}

function lastPathSegment(inputPath: string): string {
  const segments = inputPath.split(/[\\/]/u).filter(Boolean);
  return segments[segments.length - 1] ?? inputPath;
}

function looksLikeWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/u.test(value) || /^[/\\]{2}[^/\\]+[/\\][^/\\]+/u.test(value);
}
