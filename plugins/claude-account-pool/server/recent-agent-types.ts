export interface RecentAgentTypesOptions {
  /** Max distinct values retained. Defaults to 200. */
  capacity?: number;
}

export interface RecentAgentTypes {
  /** Records a distinct-value sighting, moving it to the front if already present. No-op for blank values. */
  record(value: string): void;
  /** Distinct values, most-recently-seen first. */
  list(): string[];
}

const DEFAULT_CAPACITY = 200;

/**
 * A ring buffer of distinct `labels[AGENT_TYPE_LABEL] ?? config.title`
 * values, fed from two places: the role router (agent-spawned creates, seen
 * before the account router ever runs) and the `agent.created` observer
 * (human-created leaders, which never reach the role router since they
 * carry no callerAgentId). Both feeds record the same key shape, and
 * `record` is idempotent for repeats, so double-feeding a value the router
 * already saw at `agent.created` time just moves it to the front again.
 * Powers the Phase 2 settings UI's mapping-name autocomplete.
 */
export function createRecentAgentTypes(options: RecentAgentTypesOptions = {}): RecentAgentTypes {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;

  // Most-recently-seen first.
  const order: string[] = [];

  function record(value: string): void {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return;
    }
    const existingIndex = order.indexOf(trimmed);
    if (existingIndex !== -1) {
      order.splice(existingIndex, 1);
    }
    order.unshift(trimmed);
    if (order.length > capacity) {
      order.length = capacity;
    }
  }

  return {
    record,
    list: () => [...order],
  };
}
