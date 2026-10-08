/**
 * Files every `http(s)` URL in human-typed prompt text to the knowledge base (KTD-8). Only the
 * app's two human send paths call this (session.ts beside `recordHumanPrompt`, and the initial
 * prompt on agent create) — agent-to-agent prompts are never scanned, because those links were
 * Tyler's in the parent's session and were filed there already.
 *
 * U5 installs the knowledge-base service as the sink once it exists; until then (and whenever the
 * feature is disabled) `captureLinksFromPrompt` is a no-op, so the daemon pays nothing for this
 * while the knowledge base is off.
 */

import type { Logger } from "pino";

import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
import { scrubUrl } from "./scrub.js";

export type LinkKind = "figma" | "ticket" | "pr" | "thread" | "doc" | "dashboard" | "link";

export interface CapturedLink {
  /** Already scrubbed (KTD-10): no userinfo, no secret-shaped query params. */
  url: string;
  kind: LinkKind;
  host: string;
}

export type LinkCaptureSink = (agentId: string, link: CapturedLink) => Promise<void> | void;

let installedSink: LinkCaptureSink | null = null;

/** U5 installs the knowledge-base service here. Passing `null` restores the no-op seam. */
export function setLinkCaptureSink(sink: LinkCaptureSink | null): void {
  installedSink = sink;
}

// One global match of `https?://` followed by a single negated character class (KTD-9): no
// nested or optional-inside-repeated quantifier, so it stays linear on hostile input.
const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]]+/gu;

const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?"]);

/** Peels sentence punctuation off the end, a character at a time — a loop, not a regex (KTD-9). */
function trimTrailingPunctuation(url: string): string {
  let end = url.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(url.charAt(end - 1))) {
    end -= 1;
  }
  return url.slice(0, end);
}

function textPartsOf(prompt: AgentPromptInput): string[] {
  if (typeof prompt === "string") return [prompt];
  const parts: string[] = [];
  for (const block of prompt) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts;
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

/** Loopback and private-network hosts are noise (KTD-8): a dev server on the same machine. */
function isLoopbackOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  const match = IPV4_PATTERN.exec(host);
  if (!match) return false;
  const a = Number(match[1]);
  const b = Number(match[2]);
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  return false;
}

const FIGMA_HOSTS = ["figma.com"];
const SLACK_HOSTS = ["slack.com"];
const DOC_HOSTS = ["docs.google.com", "notion.so"];
const DASHBOARD_HOST_NEEDLES = ["grafana", "datadoghq.com", "sentry.io"];
const TICKET_HOST_NEEDLES = ["linear.app", "atlassian.net", "jira"];
const ISSUE_PATH_SEGMENTS = new Set(["issue", "issues"]);
const PR_PATH_SEGMENTS = new Set(["pull", "pulls", "pull-requests", "merge_requests"]);

function hostMatches(hostname: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

function hostIncludesAny(hostname: string, needles: readonly string[]): boolean {
  return needles.some((needle) => hostname.includes(needle));
}

function pathHasSegment(pathname: string, segments: ReadonlySet<string>): boolean {
  return pathname
    .toLowerCase()
    .split("/")
    .some((segment) => segments.has(segment));
}

function classifyLink(url: URL): LinkKind {
  const host = url.hostname.toLowerCase();
  if (hostMatches(host, FIGMA_HOSTS)) return "figma";
  if (hostMatches(host, SLACK_HOSTS)) return "thread";
  if (hostMatches(host, DOC_HOSTS)) return "doc";
  if (hostIncludesAny(host, DASHBOARD_HOST_NEEDLES)) return "dashboard";
  if (hostIncludesAny(host, TICKET_HOST_NEEDLES)) return "ticket";
  if (pathHasSegment(url.pathname, PR_PATH_SEGMENTS)) return "pr";
  if (pathHasSegment(url.pathname, ISSUE_PATH_SEGMENTS)) return "ticket";
  return "link";
}

function extractLinks(prompt: AgentPromptInput): CapturedLink[] {
  const links: CapturedLink[] = [];
  for (const text of textPartsOf(prompt)) {
    for (const match of text.matchAll(URL_PATTERN)) {
      const candidate = trimTrailingPunctuation(match[0]);
      let parsed: URL;
      try {
        parsed = new URL(candidate);
      } catch {
        continue;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      if (isLoopbackOrPrivateHost(parsed.hostname)) continue;
      const scrubbed = scrubUrl(candidate);
      if (scrubbed === null) continue;
      links.push({ url: scrubbed, kind: classifyLink(parsed), host: parsed.hostname });
    }
  }
  return links;
}

/**
 * Hands every link in `prompt` to the installed sink, one call per link. Never throws and never
 * blocks the caller: a sink failure is logged with the link's kind and host only, never the raw
 * URL, and the rest of the links still go out.
 */
export function captureLinksFromPrompt(
  agentId: string,
  prompt: AgentPromptInput,
  logger: Pick<Logger, "warn">,
): void {
  const sink = installedSink;
  if (!sink) return;
  for (const link of extractLinks(prompt)) {
    void Promise.resolve()
      .then(() => sink(agentId, link))
      .catch((error: unknown) => {
        logger.warn(
          { err: error, kind: link.kind, host: link.host },
          "knowledge base link capture sink failed",
        );
      });
  }
}
