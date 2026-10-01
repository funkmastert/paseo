/**
 * Turns one raw JSONL transcript row into human-readable text. Providers' session rows are their
 * own wire format (Claude Agent SDK message envelopes, Codex rollout events, ...); this never
 * returns the raw JSON, only text pulled out of it, so a match never surfaces as a brace-and-quote
 * dump.
 */

export interface ExtractedExcerpt {
  role: string | null;
  text: string;
}

export function extractExcerptText(rawLine: string, maxChars: number): ExtractedExcerpt | null {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const text = extractText(parsed);
  if (!text) return null;
  return { role: extractRole(parsed), text: truncateText(text, maxChars) };
}

function extractRole(obj: Record<string, unknown>): string | null {
  const message = isRecord(obj.message) ? obj.message : null;
  if (typeof message?.role === "string") return message.role;
  if (typeof obj.role === "string") return obj.role;
  if (typeof obj.type === "string") return obj.type;
  return null;
}

function extractText(obj: Record<string, unknown>): string | null {
  const message = isRecord(obj.message) ? obj.message : null;
  const fromMessage = message ? contentToText(message.content) : null;
  if (fromMessage) return fromMessage;
  const direct = contentToText(obj.content) ?? contentToText(obj.text);
  if (direct) return direct;
  // Unknown row shape (a provider this was never taught about). Harvest every string leaf so the
  // match still surfaces as readable text, never as the row's raw JSON.
  const collected: string[] = [];
  collectStrings(obj, collected, 0);
  return collected.length > 0 ? collected.join(" ") : null;
}

function contentToText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (typeof block.text === "string") {
        parts.push(block.text);
        continue;
      }
      if (block.type === "tool_use" && typeof block.name === "string") {
        parts.push(`[tool_use: ${block.name}]`);
        continue;
      }
      if (block.type === "tool_result") {
        const inner = contentToText(block.content);
        if (inner) parts.push(`[tool_result: ${inner}]`);
      }
    }
    return parts.length > 0 ? parts.join(" ") : null;
  }
  return null;
}

function collectStrings(value: unknown, out: string[], depth: number): void {
  if (depth > 6 || out.join(" ").length > 2000) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) out.push(trimmed);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return;
  }
  if (isRecord(value)) {
    for (const v of Object.values(value)) collectStrings(v, out, depth + 1);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateText(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1)}…` : collapsed;
}
