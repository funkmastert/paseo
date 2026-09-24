import { z } from "zod";
import type { Logger } from "pino";

/**
 * Whether an agent was mid-turn, written on its own record at the edge into `running` and at the
 * edge out of it. See docs/restart-recovery.md.
 *
 * A marker with `startedAt` and no `endedAt` is open: the agent was working and nothing has
 * settled it. A daemon that stops for any reason, crash or clean shutdown, leaves the open markers
 * of every agent it closed, and the next daemon finds them.
 */
export const RUN_MARKER_SCHEMA = z.object({
  startedAt: z.string(),
  endedAt: z.string().optional(),
  /**
   * How the run ended: the lifecycle it settled into (`idle`, `error`, `closed`), or `dismissed`
   * when a person told restart recovery to leave an interrupted run alone.
   */
  endedBy: z.string().optional(),
});

export type RunMarker = z.infer<typeof RUN_MARKER_SCHEMA>;

export function isRunMarkerOpen(marker: RunMarker | null | undefined): marker is RunMarker {
  return marker !== null && marker !== undefined && marker.endedAt === undefined;
}

/** Settle an open marker; anything else is returned unchanged. */
export function settleRunMarker(
  marker: RunMarker | undefined,
  endedAt: string,
  endedBy: string,
): RunMarker | undefined {
  return isRunMarkerOpen(marker) ? { ...marker, endedAt, endedBy } : marker;
}

export interface RunMarkerStore {
  /**
   * The only write that changes an agent's run marker, run in that agent's write queue. `mutate`
   * sees the stored marker. Resolves false when the agent has no record.
   */
  updateRunMarker(
    agentId: string,
    mutate: (current: RunMarker | undefined) => RunMarker | undefined,
  ): Promise<boolean>;
}

export interface RunMarkerObservation {
  id: string;
  lifecycle: string;
  internal?: boolean;
}

/**
 * Writes run markers from the agent manager's state emissions. It keeps one bit per agent, "this
 * process opened a marker for it", so a run is written once at each edge however many state
 * emissions happen in between.
 *
 * A marker opened by an earlier daemon is never settled here: loading the agent, or looking at
 * it, does not finish the interrupted turn. Only a new run replaces it, or recovery dismisses it.
 */
export class RunMarkerTracker {
  private readonly open = new Set<string>();

  constructor(
    private readonly options: {
      store: RunMarkerStore | undefined;
      logger: Logger;
      track: (task: Promise<void>) => void;
      now?: () => Date;
    },
  ) {}

  /**
   * Called on every state emission. While the daemon is shutting down a settle is not written:
   * the agent did not finish, the daemon stopped it, and the open marker is what tells the next
   * daemon so.
   */
  observe(agent: RunMarkerObservation, context: { shuttingDown: boolean }): void {
    if (agent.internal || !this.options.store) return;
    const running = agent.lifecycle === "running";
    const opened = this.open.has(agent.id);
    if (running && !opened) {
      this.open.add(agent.id);
      const startedAt = this.nowIso();
      this.write(agent.id, () => ({ startedAt }));
      return;
    }
    if (!running && opened && !context.shuttingDown) {
      this.open.delete(agent.id);
      const endedAt = this.nowIso();
      this.write(agent.id, (current) => settleRunMarker(current, endedAt, agent.lifecycle));
    }
  }

  private write(
    agentId: string,
    mutate: (current: RunMarker | undefined) => RunMarker | undefined,
  ): void {
    const store = this.options.store;
    if (!store) return;
    const task = store
      .updateRunMarker(agentId, mutate)
      .then(() => undefined)
      .catch((error) => {
        this.options.logger.warn({ err: error, agentId }, "Failed to write run marker");
      });
    this.options.track(task);
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}
