import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import type {
  AgentContextUsage,
  AgentContextUsageCategory,
  AgentContextUsageReadResponse,
} from "@getpaseo/protocol/context-usage/rpc-schemas";
import { formatTokenCount } from "@/components/context-window-meter.utils";

// The rendering rules for the context meter: where it turns amber and red, and how a provider's
// `/context` breakdown becomes rows, bar segments and warnings. Pure so the rules are tested
// against real captures. Copy for the warnings lives in the component; this only decides which
// warnings exist and what figures they carry. See docs/context-usage.md.

export interface ContextMeterThresholds {
  amberTokens: number;
  amberPercent: number;
  redTokens: number;
  redPercent: number;
  memoryFilesTokens: number;
  memoryFileTokens: number;
}

export const DEFAULT_CONTEXT_METER_THRESHOLDS: ContextMeterThresholds = {
  amberTokens: 200_000,
  amberPercent: 70,
  redTokens: 400_000,
  redPercent: 80,
  memoryFilesTokens: 10_000,
  memoryFileTokens: 5_000,
};

export type AgentContextUsagePayload = AgentContextUsageReadResponse["payload"];

export type ContextMeterTone = "neutral" | "amber" | "red";

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resolveContextMeterThresholds(
  config?: MutableDaemonConfig["contextMeter"],
): ContextMeterThresholds {
  const defaults = DEFAULT_CONTEXT_METER_THRESHOLDS;
  return {
    amberTokens: positiveOr(config?.amberTokens, defaults.amberTokens),
    amberPercent: positiveOr(config?.amberPercent, defaults.amberPercent),
    redTokens: positiveOr(config?.redTokens, defaults.redTokens),
    redPercent: positiveOr(config?.redPercent, defaults.redPercent),
    memoryFilesTokens: positiveOr(config?.memoryFilesTokens, defaults.memoryFilesTokens),
    memoryFileTokens: positiveOr(config?.memoryFileTokens, defaults.memoryFileTokens),
  };
}

export function resolveContextMeterTone(
  usage: { usedTokens: number; maxTokens: number },
  thresholds: ContextMeterThresholds,
): ContextMeterTone {
  const { usedTokens, maxTokens } = usage;
  const percent =
    Number.isFinite(maxTokens) && maxTokens > 0 ? (usedTokens / maxTokens) * 100 : null;
  if (usedTokens > thresholds.redTokens || (percent !== null && percent >= thresholds.redPercent)) {
    return "red";
  }
  if (
    usedTokens > thresholds.amberTokens ||
    (percent !== null && percent >= thresholds.amberPercent)
  ) {
    return "amber";
  }
  return "neutral";
}

function trimTrailingZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

/**
 * The context meter shows small figures the provider estimated to the token, so it keeps a
 * decimal where the shared formatter would round 8,580 up to "9k".
 */
export function formatContextTokens(value: number): string {
  if (value < 1_000) return Math.round(value).toString();
  if (value < 100_000) return `${trimTrailingZero(Math.round(value / 100) / 10)}k`;
  if (value < 999_500) return formatTokenCount(value);
  return `${trimTrailingZero(Math.round(value / 100_000) / 10)}m`;
}

function formatPercentOfWindow(percent: number): string {
  if (percent < 0.1) return "<0.1%";
  if (percent < 10) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}

export type ContextRowKind = "used" | "deferred" | "buffer" | "free";

export interface ContextBreakdownRow {
  id: string;
  label: string;
  kind: ContextRowKind;
  tokens: number;
  formattedTokens: string;
  /** Share of the window, 0-100. Null for deferred rows and when the window size is unknown. */
  percent: number | null;
  formattedPercent: string | null;
}

export interface ContextBarSegment {
  id: string;
  kind: "used" | "buffer";
  /** Share of the window, 0-1. */
  fraction: number;
}

export type ContextMessageRowId =
  | "toolResults"
  | "attachments"
  | "assistant"
  | "toolCalls"
  | "user";

export interface ContextMessageRow {
  id: ContextMessageRowId;
  tokens: number;
  formattedTokens: string;
}

export interface ContextMemoryFileWarning {
  path: string;
  shortPath: string;
  tokens: number;
  formattedTokens: string;
  limitFormatted: string;
}

export interface ContextMemoryWarnings {
  total: { tokens: number; formattedTokens: string; limitFormatted: string } | null;
  files: ContextMemoryFileWarning[];
}

export interface ContextBreakdownView {
  rows: ContextBreakdownRow[];
  deferredRows: ContextBreakdownRow[];
  segments: ContextBarSegment[];
  messageRows: ContextMessageRow[];
  memory: ContextMemoryWarnings;
  /** Epoch ms of the capture; NaN when the daemon sent a time that does not parse. */
  capturedAt: number;
}

function normalizeKind(kind: string): ContextRowKind {
  return kind === "deferred" || kind === "buffer" || kind === "free" ? kind : "used";
}

function buildRow(category: AgentContextUsageCategory, maxTokens: number): ContextBreakdownRow {
  const kind = normalizeKind(category.kind);
  const percent =
    kind !== "deferred" && Number.isFinite(maxTokens) && maxTokens > 0
      ? (category.tokens / maxTokens) * 100
      : null;
  return {
    id: category.id,
    label: category.label,
    kind,
    tokens: category.tokens,
    formattedTokens: formatContextTokens(category.tokens),
    percent,
    formattedPercent: percent === null ? null : formatPercentOfWindow(percent),
  };
}

function buildSegments(rows: ContextBreakdownRow[], maxTokens: number): ContextBarSegment[] {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return [];
  const drawn = rows.filter((row) => row.kind === "used" || row.kind === "buffer");
  const total = drawn.reduce((sum, row) => sum + row.tokens, 0);
  const scale = total > maxTokens ? maxTokens / total : 1;
  return drawn.map((row) => ({
    id: row.id,
    kind: row.kind === "buffer" ? "buffer" : "used",
    fraction: (row.tokens / maxTokens) * scale,
  }));
}

function buildMessageRows(usage: AgentContextUsage): ContextMessageRow[] {
  const breakdown = usage.messageBreakdown;
  if (!breakdown) return [];
  const candidates: Array<[ContextMessageRowId, number]> = [
    ["toolResults", breakdown.toolResultTokens],
    ["attachments", breakdown.attachmentTokens],
    ["assistant", breakdown.assistantMessageTokens],
    ["toolCalls", breakdown.toolCallTokens],
    ["user", breakdown.userMessageTokens],
  ];
  return candidates
    .filter(([, tokens]) => tokens > 0)
    .toSorted((a, b) => b[1] - a[1])
    .map(([id, tokens]) => ({ id, tokens, formattedTokens: formatContextTokens(tokens) }));
}

function shortenPath(path: string): string {
  return path
    .split(/[\\/]/)
    .filter((segment) => segment.length > 0)
    .slice(-2)
    .join("/");
}

function buildMemoryWarnings(
  usage: AgentContextUsage,
  thresholds: ContextMeterThresholds,
): ContextMemoryWarnings {
  const category = usage.categories.find((entry) => entry.id === "memory_files");
  const totalTokens =
    category?.tokens ?? usage.memoryFiles.reduce((sum, file) => sum + file.tokens, 0);
  return {
    total:
      totalTokens > thresholds.memoryFilesTokens
        ? {
            tokens: totalTokens,
            formattedTokens: formatContextTokens(totalTokens),
            limitFormatted: formatContextTokens(thresholds.memoryFilesTokens),
          }
        : null,
    files: usage.memoryFiles
      .filter((file) => file.tokens > thresholds.memoryFileTokens)
      .map((file) => ({
        path: file.path,
        shortPath: shortenPath(file.path),
        tokens: file.tokens,
        formattedTokens: formatContextTokens(file.tokens),
        limitFormatted: formatContextTokens(thresholds.memoryFileTokens),
      })),
  };
}

export function buildContextBreakdownView(
  usage: AgentContextUsage,
  thresholds: ContextMeterThresholds,
): ContextBreakdownView {
  const rows = usage.categories
    .filter((category) => category.tokens > 0)
    .map((category) => buildRow(category, usage.maxTokens));
  const ofKind = (kind: ContextRowKind) => rows.filter((row) => row.kind === kind);
  return {
    rows: [...ofKind("used"), ...ofKind("buffer"), ...ofKind("free")],
    deferredRows: ofKind("deferred"),
    segments: buildSegments(rows, usage.maxTokens),
    messageRows: buildMessageRows(usage),
    memory: buildMemoryWarnings(usage, thresholds),
    capturedAt: Date.parse(usage.capturedAt),
  };
}

/**
 * The token figure for "this session re-reads ~N tokens every turn", once the session is big
 * enough that a fresh one with a short handoff is the cheaper move. Null while the meter is
 * neutral.
 */
export function buildReReadAdvice(usedTokens: number, tone: ContextMeterTone): string | null {
  return tone === "neutral" ? null : formatContextTokens(usedTokens);
}
