import { JEV_FEATURE_LABELS } from "@getpaseo/protocol/jev/labels";
import type { JevDecisionRecord } from "./contract.js";

/**
 * A plain-words one-line summary of a decision (docs/jev.md, "Feature 11"), for the agent
 * header's JEV badge and the timeline marker. One case per feature; an id this function doesn't
 * know yet — a sibling track's new feature merged before its own case lands here — falls through
 * to the generic line, so the marker still reads rather than going blank.
 */
export function summarizeJevDecision(record: JevDecisionRecord): string {
  const shadow = record.mode === "shadow";
  switch (record.feature) {
    case "spawnHint":
      if (record.wouldBe) {
        return record.applied
          ? `JEV set this create's task class: ${record.wouldBe}`
          : `JEV would have set this create's task class: ${record.wouldBe}`;
      }
      return `JEV classified this create: ${record.verdict}`;
    case "stallJudgment":
      return "JEV judged the stall needs you";
    case "remediationTriage":
      return shadow
        ? `JEV would have triaged the remediation: ${record.verdict}`
        : `JEV triaged the remediation: ${record.verdict}`;
    case "notificationTriage":
      return shadow
        ? `JEV would have reviewed the finish: ${record.verdict}`
        : `JEV reviewed the finish: ${record.verdict}`;
    case "compactionTiming":
      return shadow
        ? `JEV would have timed the compaction: ${record.verdict}`
        : `JEV timed the compaction: ${record.verdict}`;
    case "awayReply":
      return shadow ? "JEV drafted an away reply (dry run)" : "JEV sent an away reply";
    case "agentTools":
      return `JEV answered a tool question: ${record.verdict}`;
    case "askJev":
      return `JEV answered: ${record.verdict}`;
    case "readCheck":
      return shadow
        ? `JEV would have skipped re-reading: ${record.question}`
        : `JEV skipped re-reading: ${record.question}`;
    case "titleRefresh":
      return "JEV refreshed the session title";
    default:
      return `JEV ran ${JEV_FEATURE_LABELS[record.feature] ?? record.feature}: ${record.verdict}`;
  }
}
