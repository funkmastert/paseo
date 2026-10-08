import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  BasicMemoryClient,
  BasicMemorySearchError,
  parseSearchResults,
} from "./basic-memory-client.js";
import { BasicMemorySidecar } from "./basic-memory-sidecar.js";
import { writeFakeBasicMemory, type FakeBasicMemory } from "./test-utils/fake-basic-memory.js";

const tempDirs: string[] = [];
const sidecars: BasicMemorySidecar[] = [];

afterEach(async () => {
  while (sidecars.length > 0) await sidecars.pop()?.stop();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

async function startFake(): Promise<{ sidecar: BasicMemorySidecar; fake: FakeBasicMemory }> {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-kb-client-"));
  tempDirs.push(root);
  const fake = writeFakeBasicMemory(path.join(root, "bin"));
  const sidecar = new BasicMemorySidecar({ logger: createTestLogger(), fallbackBinDirs: [] });
  sidecars.push(sidecar);
  await sidecar.applyConfig({
    enabled: true,
    notesDir: path.join(root, "knowledge"),
    basicMemory: { command: fake.command, semanticSearch: true },
  });
  expect(sidecar.getStatus().state).toBe("running");
  return { sidecar, fake };
}

function searchInputs(fake: FakeBasicMemory): Array<Record<string, unknown> | undefined> {
  return fake.calls().flatMap((call) => (call.tool === "search_notes" ? [call.input] : []));
}

async function searchError(promise: Promise<unknown>): Promise<BasicMemorySearchError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BasicMemorySearchError) return error;
    throw error;
  }
  throw new Error("Expected the search to fail");
}

// Rows as Basic Memory 0.23.2 returns them with output_format "json" (recorded in the U4 smoke
// run), trimmed to the fields that vary.
const checkoutRow = {
  title: "Checkout redesign",
  type: "entity",
  score: 1.245,
  entity: "projects/checkout-redesign",
  permalink: "projects/checkout-redesign",
  content: "# Checkout redesign\n\n## Summary\n\nRebuild the cart.",
  matched_chunk: "## Decisions\n\n- [decision] Ship behind the flag enable_express_checkout_v2",
  file_path: "projects/checkout-redesign.md",
  updated_at: "2026-10-07T20:10:37.375786-07:00",
  metadata: { note_type: "project" },
  entity_id: 5,
};
const scratchRow = {
  title: "Obsidian scratch",
  type: "entity",
  score: 0.666,
  content: "A note made in Obsidian\nwith no permalink.",
  file_path: "obsidian-scratch.md",
  updated_at: "2026-10-07T20:10:37.385237-07:00",
  entity_id: 3,
};

describe("BasicMemoryClient", () => {
  test("search maps Basic Memory's JSON results", async () => {
    const { sidecar, fake } = await startFake();
    fake.setSearchResults({ checkout: [checkoutRow, scratchRow] });

    const results = await new BasicMemoryClient({ sidecar }).search({ query: "checkout" });

    expect(results).toEqual([
      {
        permalink: "projects/checkout-redesign",
        filePath: "projects/checkout-redesign.md",
        title: "Checkout redesign",
        score: 1.245,
        snippet: "## Decisions - [decision] Ship behind the flag enable_express_checkout_v2",
        noteType: "project",
      },
      {
        permalink: null,
        filePath: "obsidian-scratch.md",
        title: "Obsidian scratch",
        score: 0.666,
        snippet: "A note made in Obsidian with no permalink.",
        noteType: null,
      },
    ]);
    expect(searchInputs(fake)).toEqual([
      { query: "checkout", page_size: 10, output_format: "json" },
    ]);
  });

  test("search passes the search type, note types, similarity floor and limit", async () => {
    const { sidecar, fake } = await startFake();

    await new BasicMemoryClient({ sidecar }).search({
      query: "Checkout redesign (Android)",
      limit: 3,
      searchType: "vector",
      noteTypes: ["project"],
      minSimilarity: 0.7,
    });

    expect(searchInputs(fake)).toEqual([
      {
        query: "Checkout redesign (Android)",
        page_size: 3,
        output_format: "json",
        search_type: "vector",
        note_types: ["project"],
        min_similarity: 0.7,
      },
    ]);
  });

  test("a search while the sidecar is not running is search_unavailable", async () => {
    const sidecar = new BasicMemorySidecar({ logger: createTestLogger() });

    const error = await searchError(new BasicMemoryClient({ sidecar }).search({ query: "x" }));

    expect(error.code).toBe("search_unavailable");
    expect(error.sidecarStatus).toEqual({ state: "disabled" });
  });

  test("a search that times out returns search_timeout and the sidecar stays up", async () => {
    const { sidecar, fake } = await startFake();
    fake.setSearchResults({ checkout: [checkoutRow] });
    const client = new BasicMemoryClient({ sidecar, timeoutMs: 300 });

    const error = await searchError(client.search({ query: "slow" }));

    expect(error.code).toBe("search_timeout");
    expect(sidecar.getStatus().state).toBe("running");
    expect(await client.search({ query: "checkout" })).toHaveLength(1);
  });

  test("a tool error is search_failed with Basic Memory's message", async () => {
    const { sidecar } = await startFake();

    const error = await searchError(new BasicMemoryClient({ sidecar }).search({ query: "broken" }));

    expect(error.code).toBe("search_failed");
    expect(error.message).toBe("Semantic search is disabled");
  });

  test("a result that is not JSON is search_failed", async () => {
    const { sidecar } = await startFake();

    const error = await searchError(
      new BasicMemoryClient({ sidecar }).search({ query: "not-json" }),
    );

    expect(error.code).toBe("search_failed");
  });

  test("a structured result wrapped by FastMCP is read too", () => {
    expect(
      parseSearchResults({
        content: [],
        structuredContent: { result: { results: [checkoutRow] } },
      }).map((result) => result.permalink),
    ).toEqual(["projects/checkout-redesign"]);
  });

  test("a 640 KB note maps to a capped snippet in under 100 ms", () => {
    const hostile = " \t\n".repeat(120_000) + "x ".repeat(150_000);
    expect(hostile.length).toBeGreaterThan(640 * 1024);
    const raw = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ results: [{ ...scratchRow, content: hostile }] }),
        },
      ],
    };

    const started = performance.now();
    const [result] = parseSearchResults(raw);
    const elapsed = performance.now() - started;

    expect(result?.snippet.length).toBeLessThanOrEqual(300);
    expect(elapsed).toBeLessThan(100);
  });
});
