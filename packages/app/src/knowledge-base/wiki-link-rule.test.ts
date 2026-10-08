import { describe, expect, it } from "vitest";
import type MarkdownIt from "markdown-it";
import type { KnowledgeBaseNoteSummary } from "@getpaseo/protocol/knowledge-base/rpc-schemas";
import {
  createKnowledgeMarkdownParser,
  createWikiLinkResolver,
  knowledgeNoteHref,
  parseKnowledgeNoteHref,
  parseObservationCategory,
  scanWikiLink,
} from "./wiki-link-rule";

function note(path: string, title: string, noteType = "project"): KnowledgeBaseNoteSummary {
  return {
    path,
    permalink: path.replace(/\.md$/, ""),
    title,
    noteType,
    modifiedAt: 0,
    linkCount: 0,
    decisionCount: 0,
  };
}

const NOTES = [
  note("projects/on-site-recording.md", "On-site recording"),
  note("projects/checkout-redesign.md", "Checkout redesign"),
  note("inbox.md", "Inbox", "inbox"),
];

const parser = createKnowledgeMarkdownParser(createWikiLinkResolver(NOTES));

interface InlinePiece {
  type: string;
  content?: string;
  href?: string;
}

/** The inline tokens of the first paragraph-level inline block, reduced to what renders. */
function inline(markdown: string, md: MarkdownIt = parser): InlinePiece[] {
  const block = md.parse(markdown, {}).find((token) => token.type === "inline");
  if (!block?.children) throw new Error(`no inline block in ${JSON.stringify(markdown)}`);
  return block.children.map((token) => {
    if (token.type === "link_open") return { type: token.type, href: token.attrGet("href") ?? "" };
    if (token.type === "link_close") return { type: token.type };
    return { type: token.type, content: token.content };
  });
}

describe("wiki-link rule", () => {
  it("turns [[On-site recording]] into a link to that note", () => {
    expect(inline("See [[On-site recording]] for context")).toEqual([
      { type: "text", content: "See " },
      { type: "link_open", href: knowledgeNoteHref("projects/on-site-recording.md") },
      { type: "text", content: "On-site recording" },
      { type: "link_close" },
      { type: "text", content: " for context" },
    ]);
  });

  it("leaves [[Missing]] as plain text", () => {
    expect(inline("See [[Missing]] later")).toEqual([
      { type: "text", content: "See [[Missing]] later" },
    ]);
  });

  it("resolves by permalink and file name, ignoring case, and shows an alias after the pipe", () => {
    expect(inline("[[projects/checkout-redesign|the checkout work]]")).toEqual([
      { type: "link_open", href: knowledgeNoteHref("projects/checkout-redesign.md") },
      { type: "text", content: "the checkout work" },
      { type: "link_close" },
    ]);
    expect(inline("[[ON-SITE-RECORDING]]")).toEqual([
      { type: "link_open", href: knowledgeNoteHref("projects/on-site-recording.md") },
      { type: "text", content: "ON-SITE-RECORDING" },
      { type: "link_close" },
    ]);
  });

  it("resolves a heading link to its note", () => {
    expect(inline("[[Checkout redesign#Decisions]]")).toEqual([
      { type: "link_open", href: knowledgeNoteHref("projects/checkout-redesign.md") },
      { type: "text", content: "Checkout redesign#Decisions" },
      { type: "link_close" },
    ]);
  });

  it("does not link inside code spans", () => {
    expect(inline("Write `[[On-site recording]]` to link")).toEqual([
      { type: "text", content: "Write " },
      { type: "code_inline", content: "[[On-site recording]]" },
      { type: "text", content: " to link" },
    ]);
  });

  it("does not link across a line break or an empty target", () => {
    expect(inline("[[On-site\nrecording]] and [[]]")).not.toContainEqual(
      expect.objectContaining({ type: "link_open" }),
    );
  });

  it("round-trips a note path through its href", () => {
    expect(parseKnowledgeNoteHref(knowledgeNoteHref("projects/a b.md"))).toBe("projects/a b.md");
    expect(parseKnowledgeNoteHref("https://example.com/projects/a.md")).toBeNull();
  });
});

describe("observation categories", () => {
  it("renders the category of a `- [category] text` observation as its own token", () => {
    expect(inline("- [decision] Ship behind the flag — reviewers asked")).toEqual([
      { type: "kb_category", content: "decision" },
      { type: "text", content: " Ship behind the flag — reviewers asked" },
    ]);
  });

  it("keeps the rest of the observation linkified and wiki-linked", () => {
    expect(
      inline("- [figma] https://figma.com/file/fake-figma-key-do-not-use (2026-10-07)"),
    ).toEqual([
      { type: "kb_category", content: "figma" },
      { type: "text", content: " " },
      {
        type: "link_open",
        href: "https://figma.com/file/fake-figma-key-do-not-use",
      },
      { type: "text", content: "https://figma.com/file/fake-figma-key-do-not-use" },
      { type: "link_close" },
      { type: "text", content: " (2026-10-07)" },
    ]);
    expect(inline("- [related] [[Checkout redesign]]")).toEqual([
      { type: "kb_category", content: "related" },
      { type: "text", content: " " },
      { type: "link_open", href: knowledgeNoteHref("projects/checkout-redesign.md") },
      { type: "text", content: "Checkout redesign" },
      { type: "link_close" },
    ]);
  });

  it("leaves task checkboxes and bracketed text outside list items alone", () => {
    expect(inline("- [ ] write the doc")).toEqual([{ type: "text", content: "[ ] write the doc" }]);
    expect(inline("- [x] write the doc")).toEqual([{ type: "text", content: "[x] write the doc" }]);
    expect(inline("[decision] not an observation")).toEqual([
      { type: "text", content: "[decision] not an observation" },
    ]);
  });

  it("parses the category prefix", () => {
    expect(parseObservationCategory("[ticket] ABC-123")).toEqual({
      category: "ticket",
      rest: " ABC-123",
    });
    expect(parseObservationCategory("[ticket]ABC-123")).toBeNull();
    expect(parseObservationCategory("[  ] spaces")).toBeNull();
  });
});

describe("hostile input", () => {
  const SIZE = 640 * 1024;

  it("scans wiki links linearly", () => {
    const unclosed = `[[${"a".repeat(SIZE)}`;
    const nested = "[[".repeat(SIZE / 2);
    const start = performance.now();
    for (let pos = 0; pos < 2000; pos += 1) scanWikiLink(unclosed, pos);
    for (let pos = 0; pos < nested.length; pos += 2) scanWikiLink(nested, pos);
    expect(performance.now() - start).toBeLessThan(100);
  });

  it("parses observation categories in bounded time", () => {
    const longCategory = `[${"a".repeat(SIZE)}] text`;
    const brackets = "[".repeat(SIZE);
    const start = performance.now();
    expect(parseObservationCategory(longCategory)).toBeNull();
    expect(parseObservationCategory(brackets)).toBeNull();
    expect(performance.now() - start).toBeLessThan(100);
  });

  it("parses a 640 KB note full of wiki links", () => {
    const linky = "[[On-site recording]] [[Missing]] ".repeat(Math.ceil(SIZE / 34));
    const start = performance.now();
    parser.parse(linky, {});
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
