import { describe, expect, test } from "vitest";

import { createProjectNote, type NoteDocument } from "./note-format.js";
import { buildProjectSummary, PROJECT_SUMMARY_MAX_CHARS } from "./summary.js";

function projectNote(input: {
  summary: string;
  links?: string[];
  decisions?: string[];
}): NoteDocument {
  const doc = createProjectNote({ title: "Checkout redesign", summary: "", created: "2026-10-08" });
  const sections = doc.sections.map((section) => {
    if (section.heading === "## Summary")
      return { ...section, bodyLines: input.summary.split("\n") };
    if (section.heading === "## Links") return { ...section, bodyLines: input.links ?? [] };
    if (section.heading === "## Decisions") return { ...section, bodyLines: input.decisions ?? [] };
    return section;
  });
  return { ...doc, sections };
}

describe("buildProjectSummary", () => {
  test("names the project, its first Summary paragraph, the counts and kb_open", () => {
    const doc = projectNote({
      summary: "Redesign the checkout flow.\nOne page instead of three.\n\nSecond paragraph.",
      links: [
        "- [figma] https://www.figma.com/design/fake123/Checkout (2026-10-07)",
        "- [ticket] https://linear.app/fake-team/issue/FAKE-42 (2026-10-07)",
      ],
      decisions: ["- [decision] Ship behind a flag (2026-10-07)"],
    });

    expect(buildProjectSummary(doc, "checkout-redesign")).toBe(
      [
        "Knowledge-base project for this session: Checkout redesign (checkout-redesign).",
        "Redesign the checkout flow. One page instead of three.",
        "It records 2 links and 1 decision.",
        'Call kb_open("checkout-redesign") for the links, decisions, rules and status before relying on them.',
      ].join("\n"),
    );
  });

  test("a long Summary is cut so the whole summary stays within 800 characters and still names kb_open", () => {
    const doc = projectNote({ summary: "word ".repeat(1_000).trim() });

    const summary = buildProjectSummary(doc, "checkout-redesign");

    expect(summary.length).toBeLessThanOrEqual(PROJECT_SUMMARY_MAX_CHARS);
    expect(summary.length).toBeGreaterThan(PROJECT_SUMMARY_MAX_CHARS - 10);
    expect(
      summary.endsWith(
        'Call kb_open("checkout-redesign") for the links, decisions, rules and status before relying on them.',
      ),
    ).toBe(true);
    const summaryLine = summary.split("\n")[1];
    expect(summaryLine.startsWith("word word")).toBe(true);
    expect(summaryLine.endsWith("…")).toBe(true);
  });

  test("a token Obsidian left in the Summary does not reach the snapshot", () => {
    const doc = projectNote({ summary: `Staging key sk-ant-${"a".repeat(20)} is shared.` });

    expect(buildProjectSummary(doc, "checkout-redesign")).toContain(
      "Staging key [redacted] is shared.",
    );
  });
});
