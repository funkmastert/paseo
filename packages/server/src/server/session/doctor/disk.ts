import { finding, type DoctorCheck, type DoctorContext } from "./context.js";
import { formatBytes } from "./helpers.js";

const GIB = 1024 ** 3;
/** Same default as the artifact janitor's disk guard: one parallel test run's worth of room. */
const DEFAULT_MIN_FREE_BYTES = 20 * GIB;
const WARN_FACTOR = 1.5;

function readMinFreeBytes(ctx: DoctorContext): { bytes: number; configured: boolean } {
  const agents = ctx.rawConfig?.["agents"] as Record<string, unknown> | undefined;
  const janitor = agents?.["artifactJanitor"] as Record<string, unknown> | undefined;
  const guard = janitor?.["diskGuard"] as Record<string, unknown> | undefined;
  const value = guard?.["minFreeBytes"];
  return typeof value === "number" && value > 0
    ? { bytes: value, configured: true }
    : { bytes: DEFAULT_MIN_FREE_BYTES, configured: false };
}

export const diskCheck: DoctorCheck = {
  id: "disk.free",
  category: "disk",
  timeoutMs: 5_000,
  async run(ctx) {
    const { freeBytes, totalBytes } = await ctx.probes.statfs(ctx.paseoHome);
    const floor = readMinFreeBytes(ctx);
    const summary = `${formatBytes(freeBytes)} free of ${formatBytes(totalBytes)}`;
    const floorText = `${formatBytes(floor.bytes)} floor${floor.configured ? "" : " (the artifact janitor's default)"}`;
    if (freeBytes < floor.bytes) {
      return [
        finding("disk.free", "disk", "fail", `Disk is below the floor: ${summary}`, {
          detail: `Below the ${floorText}. A full volume takes down every agent, not just the one that asked for space.`,
          why: "Builds, git operations and agent sessions fail with write errors, and the failure does not point at the disk.",
          fix: "Archive finished worktrees (see the worktrees finding below), then `xcrun simctl delete unavailable` and clear DerivedData if Xcode is in use.",
        }),
      ];
    }
    if (freeBytes < floor.bytes * WARN_FACTOR) {
      return [
        finding("disk.free", "disk", "warn", `Disk is close to the floor: ${summary}`, {
          detail: `Less than ${WARN_FACTOR}x the ${floorText}.`,
          why: "One parallel test run can clone ~16 GB of simulators before a single test finishes.",
          fix: "Archive finished worktrees (see the worktrees finding below).",
        }),
      ];
    }
    return [finding("disk.free", "disk", "ok", `Disk: ${summary}`)];
  },
};
