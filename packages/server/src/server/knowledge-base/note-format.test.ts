import { describe, expect, test } from "vitest";

import {
  addObservation,
  createProjectNote,
  extractWikiLinkTargets,
  findSection,
  mergeNotes,
  parseNote,
  renameNote,
  rewriteWikiLinks,
  serializeNote,
} from "./note-format.js";

describe("parseNote / serializeNote round trip", () => {
  test("an Obsidian-edited note with an extra frontmatter key, an unowned section and CRLF round-trips byte for byte", () => {
    const content = [
      "---",
      "title: Checkout redesign",
      "type: project",
      "permalink: projects/checkout-redesign",
      "tags:",
      "  - project",
      "aliases: []",
      "created: 2026-10-07",
      "obsidian_custom_field: kept as-is",
      "---",
      "",
      "## Summary",
      "A redesign of checkout.",
      "",
      "## Links",
      "- [figma] https://www.figma.com/design/fake123/Checkout (2026-10-07)",
      "",
      "## My Private Notes",
      "This section is not one Bozeo knows about.",
      "",
    ].join("\r\n");

    const doc = parseNote(content);
    expect(serializeNote(doc)).toBe(content);
  });
});

describe("addObservation", () => {
  test("adding a [figma] link already present under Links leaves the note unchanged", () => {
    const doc = createProjectNote({
      title: "Checkout redesign",
      summary: "",
      created: "2026-10-07",
    });
    const once = addObservation(doc, "Links", {
      category: "figma",
      text: "https://www.figma.com/design/fake123/Checkout",
      suffix: "(2026-10-07)",
    });
    const twice = addObservation(once, "Links", {
      category: "figma",
      text: "https://www.figma.com/design/fake123/Checkout",
      suffix: "(2026-10-08)",
    });
    expect(twice).toEqual(once);
  });

  test("adding a decision to a note with no Decisions section creates it in canonical order", () => {
    const doc = createProjectNote({
      title: "Checkout redesign",
      summary: "",
      created: "2026-10-07",
    });
    const withoutDecisions = {
      ...doc,
      sections: doc.sections.filter((section) => section.heading !== "## Decisions"),
    };
    expect(findSection(withoutDecisions, "Decisions")).toBeUndefined();

    const updated = addObservation(withoutDecisions, "Decisions", {
      category: "decision",
      text: "Use Basic Memory",
      suffix: "— why: it already exists",
    });

    const headings = updated.sections.map((section) => section.heading);
    // Links, Rules, Status, Sessions, Related still bracket where Decisions belongs.
    expect(headings).toEqual([
      "## Summary",
      "## Links",
      "## Decisions",
      "## Rules",
      "## Status",
      "## Sessions",
      "## Related",
    ]);
    expect(findSection(updated, "Decisions")?.bodyLines).toEqual([
      "- [decision] Use Basic Memory — why: it already exists",
    ]);
  });
});

describe("wiki links", () => {
  test("[[A]], [[A|alias]] and [[A#heading]] resolve to target A; an unclosed [[ yields nothing", () => {
    expect(extractWikiLinkTargets("See [[A]] and [[A|alias]] and [[A#heading]].")).toEqual([
      "A",
      "A",
      "A",
    ]);
    expect(extractWikiLinkTargets("An unclosed [[ wiki link")).toEqual([]);
  });

  test("a 640 KB run of unclosed [[ parses in under 100 ms", () => {
    const hostile = "[[".repeat(320_000);
    const started = performance.now();
    expect(extractWikiLinkTargets(hostile)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(100);
  });

  test("rewriteWikiLinks rewrites [[Old]], [[Old|x]] and [[Old#h]], leaving other targets alone", () => {
    const text = "[[Old]] and [[Old|x]] and [[Old#h]] and [[Other]]";
    expect(rewriteWikiLinks(text, "Old", "New")).toBe(
      "[[New]] and [[New|x]] and [[New#h]] and [[Other]]",
    );
  });
});

describe("renameNote", () => {
  test("rewrites the title and permalink, and adds the old title to aliases", () => {
    const doc = createProjectNote({
      title: "Checkout redesign",
      summary: "",
      created: "2026-10-07",
    });
    const renamed = renameNote(doc, "Checkout flow redesign");

    expect(renamed.frontmatter.find((f) => f.key === "title")?.rawLines).toEqual([
      "title: Checkout flow redesign",
    ]);
    expect(renamed.frontmatter.find((f) => f.key === "permalink")?.rawLines).toEqual([
      "permalink: projects/checkout-flow-redesign",
    ]);
    expect(renamed.frontmatter.find((f) => f.key === "aliases")?.rawLines).toEqual([
      "aliases:",
      "  - Checkout redesign",
    ]);
  });

  test("inbound [[Old]] links in another note are rewritten with rewriteWikiLinks", () => {
    const otherNoteBody = "See [[Checkout redesign]] and [[Checkout redesign|the checkout work]].";
    expect(rewriteWikiLinks(otherNoteBody, "Checkout redesign", "Checkout flow redesign")).toBe(
      "See [[Checkout flow redesign]] and [[Checkout flow redesign|the checkout work]].",
    );
  });
});

describe("mergeNotes", () => {
  test("unions links without duplicates, concatenates decisions/rules with a (from B) marker, and adds B's title to A's aliases", () => {
    let a = createProjectNote({ title: "Checkout redesign", summary: "", created: "2026-10-07" });
    a = addObservation(a, "Links", { category: "figma", text: "https://figma.example/a" });
    a = addObservation(a, "Decisions", { category: "decision", text: "Use Basic Memory" });

    let b = createProjectNote({
      title: "Checkout redesign (Android)",
      summary: "",
      created: "2026-10-07",
    });
    b = addObservation(b, "Links", { category: "figma", text: "https://figma.example/a" });
    b = addObservation(b, "Links", { category: "ticket", text: "https://tracker.example/T-1" });
    b = addObservation(b, "Decisions", { category: "decision", text: "Ship Android first" });
    b = addObservation(b, "Rules", { category: "rule", text: "Never block on iOS parity" });

    const merged = mergeNotes(a, b);

    expect(findSection(merged, "Links")?.bodyLines).toEqual([
      "- [figma] https://figma.example/a",
      "- [ticket] https://tracker.example/T-1",
    ]);
    expect(findSection(merged, "Decisions")?.bodyLines).toEqual([
      "- [decision] Use Basic Memory",
      "- [decision] Ship Android first (from B)",
    ]);
    expect(findSection(merged, "Rules")?.bodyLines).toEqual([
      "- [rule] Never block on iOS parity (from B)",
    ]);
    expect(merged.frontmatter.find((f) => f.key === "aliases")?.rawLines).toEqual([
      "aliases:",
      "  - Checkout redesign (Android)",
    ]);
  });
});
