import {
  JEV_SAVINGS_EVENTS_FIXTURE,
  JEV_SAVINGS_SUMMARY_FIXTURES,
} from "@/jev/jev-savings-fixtures";
import type {
  JevSavingsEventsPage,
  JevSavingsEventsQuery,
  JevSavingsRange,
  JevSavingsReader,
  JevSavingsSummary,
} from "@/jev/jev-savings-types";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * A `JevSavingsReader` over fixture data, for tests and captures that don't want a live host. The
 * hooks (`use-jev-savings-summary.ts`, `use-jev-savings-events.ts`) call `DaemonClient` directly in
 * the app; this is not on that path.
 */
export function createFakeJevSavingsReader(): JevSavingsReader {
  return {
    summary(range: JevSavingsRange): Promise<JevSavingsSummary> {
      return Promise.resolve(JEV_SAVINGS_SUMMARY_FIXTURES[range]);
    },
    events(query: JevSavingsEventsQuery): Promise<JevSavingsEventsPage> {
      const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const filtered = JEV_SAVINGS_EVENTS_FIXTURE.filter((event) => {
        if (query.feature && event.feature !== query.feature) return false;
        if (query.agentId && event.agentId !== query.agentId) return false;
        return true;
      });
      const startIndex = query.cursor
        ? filtered.findIndex((event) => event.id === query.cursor) + 1
        : 0;
      const page = filtered.slice(startIndex, startIndex + limit);
      const nextCursor =
        startIndex + limit < filtered.length ? (page[page.length - 1]?.id ?? null) : null;
      return Promise.resolve({ events: page, nextCursor });
    },
  };
}
