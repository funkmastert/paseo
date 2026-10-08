import { useCallback, useMemo, type ReactElement } from "react";
import type { RenderRules } from "react-native-markdown-display";
import type { KnowledgeBaseNoteSummary } from "@getpaseo/protocol/knowledge-base/rpc-schemas";
import { createSharedMarkdownRules } from "@/components/markdown/renderer";
import { FileMarkdownPreview } from "@/file-pane/markdown-preview";
import {
  createKnowledgeMarkdownParser,
  createWikiLinkResolver,
  parseKnowledgeNoteHref,
} from "./wiki-link-rule";

const SHARED_RULES = createSharedMarkdownRules();

/** An observation's category reads as a tag: the inline-code chip, with no code semantics. */
const KNOWLEDGE_MARKDOWN_RULES: RenderRules = {
  ...SHARED_RULES,
  kb_category: (node, children, parent, styles, inheritedStyles) =>
    SHARED_RULES.code_inline?.(node, children, parent, styles, inheritedStyles) ?? null,
};

export interface KnowledgeNoteMarkdownProps {
  content: string;
  /** Every note, for resolving `[[wiki links]]`; unresolved ones stay plain text. */
  notes: readonly KnowledgeBaseNoteSummary[];
  onOpenNote: (path: string) => void;
}

/** The file pane's Markdown preview (front matter as a table) with the knowledge-base rules. */
export function KnowledgeNoteMarkdown({
  content,
  notes,
  onOpenNote,
}: KnowledgeNoteMarkdownProps): ReactElement {
  const markdownit = useMemo(
    () => createKnowledgeMarkdownParser(createWikiLinkResolver(notes)),
    [notes],
  );
  const handleLinkPress = useCallback(
    (href: string) => {
      const path = parseKnowledgeNoteHref(href);
      if (path === null) return true;
      onOpenNote(path);
      return false;
    },
    [onOpenNote],
  );
  return (
    <FileMarkdownPreview
      source={content}
      markdownit={markdownit}
      rules={KNOWLEDGE_MARKDOWN_RULES}
      onLinkPress={handleLinkPress}
    />
  );
}
