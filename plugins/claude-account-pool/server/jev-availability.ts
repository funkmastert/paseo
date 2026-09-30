import type { PluginHookContext } from "@getpaseo/plugin/server";
import type { JevToolsWorld } from "./classifier";
import { createIntervalPoller } from "./interval-poller";
import type { SpawnHintAvailability } from "./jev-hint";

/**
 * What the role hook knows about JEV on this host, from `jev.status` polled
 * every 60 seconds (docs/jev.md, "Which agents get them"). Undefined until a
 * poll answers, and again after one fails, so a stale "on" never outlives
 * the daemon that said it.
 */
export interface JevAvailabilitySnapshot {
  spawnHint: SpawnHintAvailability;
  agentTools: { active: boolean; assignShare: number };
}

export interface JevAvailability {
  get(): JevAvailabilitySnapshot | undefined;
  refresh(): Promise<JevAvailabilitySnapshot | undefined>;
  stop(): void;
}

type JevActions = NonNullable<PluginHookContext["paseo"]["jev"]>;
/** The slice of the plugin's Paseo handle this needs. `jev` is absent on a daemon without JEV. */
export type JevAvailabilityPaseo = { readonly jev?: Partial<Pick<JevActions, "status" | "checkScope">> };
type JevStatus = Awaited<ReturnType<JevActions["status"]>>;

const DEFAULT_INTERVAL_MS = 60_000;
/** `jev.status` reads memory on the daemon; anything slower is a daemon in trouble. */
const STATUS_TIMEOUT_MS = 5_000;
/** The scope check runs beside the policy refresh on the create path, so it gets the spawn hint's bound. */
export const JEV_SCOPE_CHECK_TIMEOUT_MS = 2_000;

const TIMED_OUT = Symbol("timed-out");

async function withinBound<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([promise, bound]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether a feature could send a call now: what the daemon's `isActive` answers, read off its status. */
function featureActivity(status: JevStatus, feature: string, lane: string): { active: boolean; reason: string | null } {
  if (!status.available) {
    return { active: false, reason: status.reason ?? "unavailable" };
  }
  if (status.features[feature]?.enabled !== true) {
    return { active: false, reason: "feature-disabled" };
  }
  const laneStatus = status.lanes[lane];
  if (laneStatus?.exhausted) {
    return { active: false, reason: "daily-budget" };
  }
  if (laneStatus?.circuit === "open") {
    return { active: false, reason: "circuit-open" };
  }
  return { active: true, reason: null };
}

/** Reads a status into the snapshot. Pure; exported for tests. */
export function snapshotOf(status: JevStatus): JevAvailabilitySnapshot {
  const spawnHint = featureActivity(status, "spawnHint", "control");
  const agentTools = featureActivity(status, "agentTools", "agentTools");
  const share = status.agentTools?.assignShare;
  return {
    spawnHint: {
      ...spawnHint,
      shadow: status.features.spawnHint?.shadow !== false,
      applyHard: status.spawnHint?.applyHard === true,
      applyRole: status.spawnHint?.applyRole === true,
    },
    agentTools: {
      active: agentTools.active,
      assignShare: typeof share === "number" && Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0,
    },
  };
}

export function createJevAvailability(
  paseo: JevAvailabilityPaseo,
  options: { intervalMs?: number; setIntervalFn?: typeof setInterval; clearIntervalFn?: typeof clearInterval } = {},
): JevAvailability {
  let current: JevAvailabilitySnapshot | undefined;
  const poller = createIntervalPoller({
    intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
    setIntervalFn: options.setIntervalFn,
    clearIntervalFn: options.clearIntervalFn,
    run: async () => {
      try {
        // COMPAT(jevPaseoApi): added in v0.8.x, remove after 2027-03-28. A daemon without JEV has
        // no `paseo.jev`; the snapshot stays undefined and nothing JEV runs.
        const jev = paseo.jev;
        if (typeof jev?.status !== "function") {
          current = undefined;
          return current;
        }
        const status = await withinBound(jev.status({ timeout: STATUS_TIMEOUT_MS }), STATUS_TIMEOUT_MS);
        current = status === TIMED_OUT ? undefined : snapshotOf(status);
      } catch {
        current = undefined;
      }
      return current;
    },
  });
  return {
    get: () => current,
    refresh: () => poller.runOnce(),
    stop: () => poller.stop(),
  };
}

/**
 * The world's `jevToolsAvailable` for one create, or undefined when the tools
 * cannot be on here: no status yet, or the feature off, so the decision line
 * gains nothing while JEV is off. Asks the D7 check bounded, and fails
 * closed: a check that errors or does not answer in time is `unknown`, and
 * an unknown scope gets no tools. Never throws.
 */
export async function jevToolsWorldFor(options: {
  availability: JevAvailabilitySnapshot | undefined;
  paseo: JevAvailabilityPaseo;
  cwd: string | undefined;
  callerAgentId: string | undefined;
  /** A number in [0, 1); the D8 arm is `on` below `assignShare`. */
  draw: number;
  /** Tests only. */
  timeoutMs?: number;
}): Promise<JevToolsWorld | undefined> {
  const tools = options.availability?.agentTools;
  if (!tools?.active) {
    return undefined;
  }
  let scope: JevToolsWorld["scope"] = "unknown";
  try {
    const checkScope = options.paseo.jev?.checkScope;
    if (typeof checkScope === "function" && options.cwd) {
      const answer = await withinBound(
        checkScope(
          { cwd: options.cwd, ...(options.callerAgentId ? { parentAgentId: options.callerAgentId } : {}) },
          { timeout: JEV_SCOPE_CHECK_TIMEOUT_MS },
        ),
        options.timeoutMs ?? JEV_SCOPE_CHECK_TIMEOUT_MS,
      );
      if (answer !== TIMED_OUT) {
        scope = answer === "ok" ? "ok" : "excluded";
      }
    }
  } catch {
    scope = "unknown";
  }
  return { active: true, scope, assignShare: tools.assignShare, draw: options.draw };
}
