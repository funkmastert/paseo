/**
 * The knowledge base's agent surface (docs/knowledge-base.md): four tools on the Paseo MCP
 * catalog, so every provider reaches them, not just the ones the MCP gateway brokers for. The
 * descriptions are the guidance Copilot gets, which reads no system prompt, so each says when to
 * call it. The service does the deciding (dedupe, the session write set, the secret scrub); these
 * handlers only shape input and output for a model.
 */

import { z } from "zod";

import { BasicMemorySearchError } from "../../knowledge-base/basic-memory-client.js";
import { findSection, parseNote, type NoteDocument } from "../../knowledge-base/note-format.js";
import {
  InvalidKnowledgeRequestError,
  KnowledgeBaseAgentNotFoundError,
  KnowledgeBaseDisabledError,
  KnowledgeBaseNoProjectError,
  KnowledgeLinkDroppedError,
  KnowledgeProjectNotFoundError,
  KnowledgeProjectWriteRefusedError,
  type KnowledgeBaseService,
  type KnowledgeProject,
} from "../../knowledge-base/service.js";
import { singleLine } from "../../knowledge-base/text.js";
import type { PaseoToolConfig, PaseoToolExecutionContext, PaseoToolResult } from "./types.js";

export type KnowledgeBaseToolsService = Pick<
  KnowledgeBaseService,
  | "isEnabled"
  | "recall"
  | "listProjects"
  | "findProject"
  | "readProject"
  | "create"
  | "join"
  | "record"
>;

export interface RegisterKnowledgeBaseToolsOptions {
  registerTool: (
    name: string,
    config: PaseoToolConfig,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tool inputs are validated by the catalog before execution.
    handler: (input: any, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>,
  ) => void;
  /** Absent on a daemon without one; the tools are registered only while it is on. */
  knowledgeBase: KnowledgeBaseToolsService | null | undefined;
  callerAgentId?: string;
}

const SNIPPET_MAX_CHARS = 200;
const SUMMARY_MAX_CHARS = 1_500;
const ENTRY_MAX_CHARS = 500;
/** `kb_open` shows the newest this many entries of each section unless one section is asked for. */
const SECTION_MAX_ENTRIES = 30;
const FULL_SECTION_MAX_ENTRIES = 300;

const SECTIONS = {
  links: "Links",
  decisions: "Decisions",
  rules: "Rules",
  status: "Status",
} as const;
type SectionKey = keyof typeof SECTIONS;
const SECTION_KEYS = Object.keys(SECTIONS) as SectionKey[];

const NO_AGENT_MESSAGE =
  "The knowledge base needs to know which agent is asking, and this session has no agent id.";

/** What the service throws for a request it refused; anything else is a bug and propagates. */
const EXPECTED_ERRORS = [
  KnowledgeBaseDisabledError,
  KnowledgeBaseAgentNotFoundError,
  KnowledgeBaseNoProjectError,
  KnowledgeProjectNotFoundError,
  KnowledgeProjectWriteRefusedError,
  KnowledgeLinkDroppedError,
  InvalidKnowledgeRequestError,
];

function toResult(payload: unknown, isError = false): PaseoToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

async function answer(run: () => Promise<unknown>): Promise<PaseoToolResult> {
  try {
    return toResult(await run());
  } catch (error) {
    if (EXPECTED_ERRORS.some((type) => error instanceof type)) {
      return toResult({ error: (error as Error).message }, true);
    }
    throw error;
  }
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function projectRef(project: KnowledgeProject): { title: string; project: string } {
  return { title: project.title, project: project.slug };
}

/** The entries under `## <heading>`, each without its list marker, oldest first. */
function sectionEntries(doc: NoteDocument, heading: string): string[] {
  const section = findSection(doc, heading);
  if (!section) return [];
  return section.bodyLines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => truncate(line.startsWith("- ") ? line.slice(2) : line, ENTRY_MAX_CHARS));
}

function summaryText(doc: NoteDocument): string {
  const section = findSection(doc, "Summary");
  if (!section) return "";
  return truncate(section.bodyLines.join("\n").trim(), SUMMARY_MAX_CHARS);
}

/** The newest `max` entries; the newest say where the project stands now. */
function newest(entries: string[], max: number): { shown: string[]; omitted: number } {
  if (entries.length <= max) return { shown: entries, omitted: 0 };
  return { shown: entries.slice(entries.length - max), omitted: entries.length - max };
}

/**
 * Read at each catalog build, and the agent MCP endpoint builds one per request, so switching the
 * knowledge base on or off changes the tool list from the next request on.
 */
export function registerKnowledgeBaseTools(options: RegisterKnowledgeBaseToolsOptions): void {
  const { knowledgeBase, callerAgentId } = options;
  if (!knowledgeBase?.isEnabled()) return;

  options.registerTool(
    "kb_search",
    {
      title: "Search the knowledge base",
      description:
        "Search Bozeo's project knowledge base (links, decisions and status of past and current initiatives) " +
        "by a loose reference: a description, feature flag, ticket, Figma file or PR. Use it at a kickoff " +
        "before kb_create, and whenever the user refers back to earlier work.",
      inputSchema: {
        query: z.string().trim().min(1).max(500),
      },
    },
    async (input: { query: string }) =>
      answer(async () => {
        let hits;
        try {
          hits = await knowledgeBase.recall({ query: input.query });
        } catch (error) {
          if (!(error instanceof BasicMemorySearchError)) throw error;
          // Search is down, but a project list is still enough to pick from.
          const projects = await knowledgeBase.listProjects();
          return {
            error: `Search is unavailable: ${error.message}`,
            projects: projects.map(projectRef),
            hint: "Pick the matching project and kb_open it, or kb_create one if none fits.",
          };
        }
        return {
          results: hits.map((hit) => ({
            title: hit.title,
            project: hit.project,
            path: hit.path,
            type: hit.noteType,
            snippet: truncate(singleLine(hit.snippet), SNIPPET_MAX_CHARS),
          })),
          hint:
            hits.length > 0
              ? "Open a match with kb_open(project)."
              : "Nothing matched. If this is new work, create it with kb_create.",
        };
      }),
  );

  options.registerTool(
    "kb_open",
    {
      title: "Open a knowledge-base project",
      description:
        "Open a knowledge-base project: its summary, links, decisions, rules and status. Joins this session " +
        "to it (join: false only reads), so links the user pastes are filed there and kb_record can write to it.",
      inputSchema: {
        project: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe("The project's slug from kb_search, or its title."),
        join: z.boolean().optional(),
        section: z
          .enum(["links", "decisions", "rules", "status"])
          .optional()
          .describe("Every entry of one section, when the default view left some out."),
      },
    },
    async (input: { project: string; join?: boolean; section?: SectionKey }) =>
      answer(async () => {
        const found = await knowledgeBase.findProject(input.project);
        if (!found) throw new KnowledgeProjectNotFoundError(input.project);
        const join = (input.join ?? true) && callerAgentId !== undefined;
        // Join first: it moves this session's Inbox links into the note this call returns.
        if (join && callerAgentId) {
          await knowledgeBase.join({ agentId: callerAgentId, project: found.slug });
        }
        const note = await knowledgeBase.readProject(found.slug);
        if (!note) throw new KnowledgeProjectNotFoundError(input.project);
        const doc = parseNote(note.content);
        const head = { ...projectRef(note.project), joined: join };

        if (input.section) {
          const { shown, omitted } = newest(
            sectionEntries(doc, SECTIONS[input.section]),
            FULL_SECTION_MAX_ENTRIES,
          );
          return {
            ...head,
            section: input.section,
            entries: shown,
            ...(omitted > 0 ? { omitted } : {}),
          };
        }

        const sections: Partial<Record<SectionKey, string[]>> = {};
        const omitted: Partial<Record<SectionKey, number>> = {};
        for (const key of SECTION_KEYS) {
          const view = newest(sectionEntries(doc, SECTIONS[key]), SECTION_MAX_ENTRIES);
          sections[key] = view.shown;
          if (view.omitted > 0) omitted[key] = view.omitted;
        }
        const leftOut = Object.keys(omitted).length > 0;
        return {
          ...head,
          summary: summaryText(doc),
          ...sections,
          ...(leftOut
            ? {
                omitted,
                hint: "Older entries were left out; kb_open with section lists one section in full.",
              }
            : {}),
        };
      }),
  );

  options.registerTool(
    "kb_create",
    {
      title: "Create a knowledge-base project",
      description:
        "Create a knowledge-base project at the kickoff of new work, after kb_search found nothing. It may join " +
        "an existing project instead, or return candidates: open one with kb_open, or repeat with confirmNew: true " +
        "if this is different work. Tell the user the project name.",
      inputSchema: {
        title: z.string().trim().min(1).max(120),
        summary: z.string().trim().min(1).max(2_000).describe("One or two sentences on the goal."),
        confirmNew: z.boolean().optional(),
      },
    },
    async (input: { title: string; summary: string; confirmNew?: boolean }) =>
      answer(async () => {
        if (!callerAgentId) throw new InvalidKnowledgeRequestError(NO_AGENT_MESSAGE);
        const result = await knowledgeBase.create({
          agentId: callerAgentId,
          title: input.title,
          summary: input.summary,
          ...(input.confirmNew ? { confirmNew: true } : {}),
        });
        if (result.outcome === "candidates") {
          return {
            outcome: result.outcome,
            candidates: result.candidates.map(projectRef),
            reason: result.reason,
          };
        }
        return {
          outcome: result.outcome,
          ...projectRef(result.project),
          reason: result.reason,
          hint: `Tell the user this work is filed as the project "${result.project.title}".`,
        };
      }),
  );

  options.registerTool(
    "kb_record",
    {
      title: "Record into the knowledge base",
      description:
        "Record a decision (what and why), a rule, a status update, or a link you produced, into this session's " +
        "project as it happens. Links the user pastes are filed for you. Writes only to projects this session " +
        "opened or created.",
      inputSchema: {
        kind: z.enum(["decision", "rule", "status", "link"]),
        text: z.string().trim().min(1).max(2_000),
        project: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("Defaults to this session's project."),
      },
    },
    async (input: {
      kind: "decision" | "rule" | "status" | "link";
      text: string;
      project?: string;
    }) =>
      answer(async () => {
        if (!callerAgentId) throw new InvalidKnowledgeRequestError(NO_AGENT_MESSAGE);
        // A title names the same project as its slug; the write set holds slugs.
        const project = input.project
          ? ((await knowledgeBase.findProject(input.project))?.slug ?? input.project)
          : undefined;
        const result = await knowledgeBase.record({
          agentId: callerAgentId,
          kind: input.kind,
          text: input.text,
          ...(project ? { project } : {}),
        });
        return {
          recorded: input.kind,
          project: result.project,
          ...(result.removedSecretSpans > 0
            ? {
                removedSecretSpans: result.removedSecretSpans,
                hint: "Token-shaped text was replaced with [redacted]. Never record credentials.",
              }
            : {}),
        };
      }),
  );
}
