import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_BASIC_MEMORY_COMMAND,
  knowledgeBaseConfigIssues,
  resolveKnowledgeBaseConfig,
} from "./config.js";

const PASEO_HOME = "/fake/paseo-home";

describe("knowledgeBase config", () => {
  it("resolves an absent section to disabled with the documented defaults", () => {
    expect(resolveKnowledgeBaseConfig(undefined, { paseoHome: PASEO_HOME })).toEqual({
      enabled: false,
      notesDir: path.join(PASEO_HOME, "knowledge"),
      basicMemory: { command: DEFAULT_BASIC_MEMORY_COMMAND, semanticSearch: true },
    });
  });

  it("resolves { enabled: true } alone with notesDir under PASEO_HOME and semantic search on", () => {
    expect(resolveKnowledgeBaseConfig({ enabled: true }, { paseoHome: PASEO_HOME })).toEqual({
      enabled: true,
      notesDir: path.join(PASEO_HOME, "knowledge"),
      basicMemory: { command: DEFAULT_BASIC_MEMORY_COMMAND, semanticSearch: true },
    });
  });

  it("leaves the rest of the config loading and disables with a reason when notesDir is wrong-typed", () => {
    let reason: string | undefined;
    const resolved = resolveKnowledgeBaseConfig(
      { enabled: true, notesDir: 123 },
      { paseoHome: PASEO_HOME, onDisabledByConfig: (why) => (reason = why) },
    );
    expect(resolved).toEqual({
      enabled: false,
      notesDir: path.join(PASEO_HOME, "knowledge"),
      basicMemory: { command: DEFAULT_BASIC_MEMORY_COMMAND, semanticSearch: true },
    });
    expect(reason).toContain("knowledgeBase.notesDir");
  });

  it("reports an unknown key and disables only this feature", () => {
    expect(knowledgeBaseConfigIssues({ bogus: true })).toEqual([
      "knowledgeBase: unknown key(s) bogus",
    ]);
    let reason: string | undefined;
    const resolved = resolveKnowledgeBaseConfig(
      { enabled: true, bogus: true },
      { paseoHome: PASEO_HOME, onDisabledByConfig: (why) => (reason = why) },
    );
    expect(resolved.enabled).toBe(false);
    expect(reason).toContain("unknown key(s) bogus");
  });

  it("accepts a well-formed basicMemory override", () => {
    expect(
      resolveKnowledgeBaseConfig(
        { enabled: true, basicMemory: { command: "/opt/basic-memory", semanticSearch: false } },
        { paseoHome: PASEO_HOME },
      ),
    ).toEqual({
      enabled: true,
      notesDir: path.join(PASEO_HOME, "knowledge"),
      basicMemory: { command: "/opt/basic-memory", semanticSearch: false },
    });
  });

  it("is accepted by the strict schema, and unknown keys are not", () => {
    expect(
      knowledgeBaseConfigIssues({
        enabled: true,
        notesDir: "/tmp/notes",
        basicMemory: { command: "basic-memory", semanticSearch: true },
      }),
    ).toEqual([]);
    expect(knowledgeBaseConfigIssues(undefined)).toEqual([]);
    expect(knowledgeBaseConfigIssues({ notesDir: 1 })).not.toEqual([]);
  });
});
