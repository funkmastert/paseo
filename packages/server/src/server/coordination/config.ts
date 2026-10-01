import type { PersistedConfig } from "../persisted-config.js";

export type CoordinationConfigInput = NonNullable<PersistedConfig["agents"]>["coordination"];

export interface CoordinationConfig {
  enabled: boolean;
  retention: {
    closedItemMaxAgeMs: number;
    streamMaxEntries: number;
    streamMaxAgeMs: number;
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Conservative: closed items stay in the live store for a month before moving to the archive.
export const DEFAULT_CLOSED_ITEM_DAYS = 30;
export const DEFAULT_STREAM_MAX_ENTRIES = 5000;
export const DEFAULT_STREAM_MAX_AGE_DAYS = 30;

export function resolveCoordinationConfig(input: CoordinationConfigInput): CoordinationConfig {
  const retention = input?.retention;
  return {
    enabled: input?.enabled ?? false,
    retention: {
      closedItemMaxAgeMs: (retention?.closedItemDays ?? DEFAULT_CLOSED_ITEM_DAYS) * DAY_MS,
      streamMaxEntries: retention?.streamMaxEntries ?? DEFAULT_STREAM_MAX_ENTRIES,
      streamMaxAgeMs: (retention?.streamMaxAgeDays ?? DEFAULT_STREAM_MAX_AGE_DAYS) * DAY_MS,
    },
  };
}
