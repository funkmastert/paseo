import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type {
  CompactionEpisodeRow,
  CompactionEpisodeSource,
  CompactionEpisodeTrigger,
  CompactionEpisodeOutcome,
  CompactionStepOutcome,
} from "../../compaction-ledger/compaction-ledger-store.js";
import type {
  CompactionEpisodeSummary,
  CompactionRange,
} from "../../compaction-ledger/compaction-ledger-service.js";

const COMPACTION_RANGES = new Set<CompactionRange>(["today", "7d", "all"]);

/** The wire's `range` is an open string (docs/protocol-compatibility.md -- never narrow on the
 * schema); this is the one place it is checked against what the ledger actually serves. */
function compactionRange(value: string): CompactionRange {
  if (!COMPACTION_RANGES.has(value as CompactionRange)) {
    throw new Error(`unknown range "${value}": use today, 7d or all`);
  }
  return value as CompactionRange;
}

/** What the session needs from the compaction ledger service: two reads. */
export interface CompactionLedgerReader {
  page: (filter: { agentId?: string; range: CompactionRange; cursor?: string; limit?: number }) => {
    episodes: CompactionEpisodeRow[];
    nextCursor: string | null;
  };
  summary: (filter: { agentId?: string; range: CompactionRange }) => CompactionEpisodeSummary;
}

export interface CompactionSessionOptions {
  host: { emit: (message: SessionOutboundMessage) => void };
  reader: CompactionLedgerReader;
}

// The row's own closed string unions are open on the wire (docs/protocol-compatibility.md --
// never narrow); this cast is the one place that boundary is crossed, since the row is otherwise
// identical in shape to the wire schema.
function episodeOnWire(row: CompactionEpisodeRow) {
  return row as CompactionEpisodeRow & {
    source: CompactionEpisodeSource | string;
    trigger: CompactionEpisodeTrigger | string;
    outcome: CompactionEpisodeOutcome | string;
    steps: Array<{ outcome: CompactionStepOutcome | string }>;
  };
}

/** Serves `compaction.episodes.list` / `.summary` (docs/insights.md). Read-only; the service's
 * observer hook and backfill are the only writers. */
export class CompactionSession {
  private readonly host: CompactionSessionOptions["host"];
  private readonly reader: CompactionLedgerReader;

  constructor(options: CompactionSessionOptions) {
    this.host = options.host;
    this.reader = options.reader;
  }

  async handleListRequest(
    msg: Extract<SessionInboundMessage, { type: "compaction.episodes.list.request" }>,
  ): Promise<void> {
    const { episodes, nextCursor } = this.reader.page({
      agentId: msg.agentId,
      range: compactionRange(msg.range),
      cursor: msg.cursor,
      limit: msg.limit,
    });
    this.host.emit({
      type: "compaction.episodes.list.response",
      payload: {
        requestId: msg.requestId,
        episodes: episodes.map(episodeOnWire),
        nextCursor,
      },
    });
  }

  async handleSummaryRequest(
    msg: Extract<SessionInboundMessage, { type: "compaction.episodes.summary.request" }>,
  ): Promise<void> {
    const summary = this.reader.summary({
      agentId: msg.agentId,
      range: compactionRange(msg.range),
    });
    this.host.emit({
      type: "compaction.episodes.summary.response",
      payload: { requestId: msg.requestId, summary },
    });
  }
}

/** Null when the host has no compaction ledger service (only a test does), so callers stay flat. */
export function createCompactionSession(
  options: Omit<CompactionSessionOptions, "reader"> & {
    reader: CompactionLedgerReader | undefined;
  },
): CompactionSession | null {
  const { reader, ...rest } = options;
  return reader ? new CompactionSession({ ...rest, reader }) : null;
}
