import { beforeAll, describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import type { PaseoSubagentRow, ProviderSubagentRow, SubagentRow } from "./select";
import {
  buildSubagentPillPresentation,
  buildSubagentRowPresentationData,
  countFinishedSubagents,
  resolveRowLabel,
  selectVisibleSubagentRows,
} from "./track-presentation";

function row(
  overrides: Partial<PaseoSubagentRow> & Pick<PaseoSubagentRow, "id">,
): PaseoSubagentRow {
  return {
    kind: "paseo",
    id: overrides.id,
    provider: overrides.provider ?? "codex",
    title: overrides.title ?? `Agent ${overrides.id}`,
    description: null,
    subtitle: overrides.subtitle ?? null,
    status: overrides.status ?? "idle",
    turn:
      overrides.turn ??
      (overrides.status === "running"
        ? { phase: "open", turnId: null, startedAt: null, cancellationRequestId: null }
        : { phase: "idle", cancellationRequestId: null }),
    requiresAttention: overrides.requiresAttention ?? false,
    createdAt: overrides.createdAt ?? new Date("2026-04-20T00:00:00.000Z"),
  };
}

describe("buildSubagentPillPresentation", () => {
  // The real instance, so a label that names a key nobody added renders as that key and fails.
  beforeAll(async () => {
    if (!i18n.isInitialized) {
      await i18n.init();
    }
    await i18n.changeLanguage("en");
  });

  const pill = (rows: SubagentRow[]) => buildSubagentPillPresentation(i18n.t, rows);

  it("counts the children that are working, not the fan-out", () => {
    expect(pill([row({ id: "a" }), row({ id: "b", status: "running" })])).toEqual({
      segments: [{ bucket: "running", text: "1 working" }],
      accessibilityLabel: "1 working",
    });
  });

  it("counts every child in the state it reports", () => {
    expect(
      pill([
        row({ id: "a", status: "running" }),
        row({ id: "b", status: "running" }),
        row({ id: "c" }),
      ]),
    ).toEqual({
      segments: [{ bucket: "running", text: "2 working" }],
      accessibilityLabel: "2 working",
    });
  });

  it("keeps a working child visible behind a failed one instead of collapsing to the worst", () => {
    expect(
      pill([
        row({ id: "a", status: "running" }),
        row({ id: "b", status: "error", requiresAttention: true }),
        row({ id: "c", status: "error" }),
      ]),
    ).toEqual({
      segments: [
        { bucket: "failed", text: "2 failed" },
        { bucket: "running", text: "1 working" },
      ],
      accessibilityLabel: "2 failed, 1 working",
    });
  });

  it("names what it opens once every child is done", () => {
    expect(pill([row({ id: "a" }), row({ id: "b" })])).toEqual({
      segments: [{ bucket: null, text: "2 subagents" }],
      accessibilityLabel: "2 subagents",
    });
  });

  it("keeps the singular for a lone child", () => {
    expect(pill([row({ id: "a" })])).toEqual({
      segments: [{ bucket: null, text: "1 subagent" }],
      accessibilityLabel: "1 subagent",
    });
  });

  it("has nothing to mark without rows", () => {
    expect(pill([])).toEqual({
      segments: [{ bucket: null, text: "0 subagents" }],
      accessibilityLabel: "0 subagents",
    });
  });
});

describe("selectVisibleSubagentRows", () => {
  // Pins the bug report: a pill reading "2 failed" must open on exactly 2 rows, not on every
  // finished sibling the pill never mentioned — regardless of how many of those exist.
  it("matches the pill's count when some children are active — the reported bug", () => {
    const rows = [
      row({ id: "failed-1", status: "error" }),
      row({ id: "failed-2", status: "error" }),
      ...Array.from({ length: 10 }, (_unused, index) =>
        row({ id: `done-${index}`, status: "idle" }),
      ),
    ];
    const pill = buildSubagentPillPresentation(i18n.t, rows);
    const totalPillCount = pill.segments.reduce((sum, segment) => {
      const match = /^(\d+)/.exec(segment.text);
      return sum + (match ? Number(match[1]) : 0);
    }, 0);
    const visible = selectVisibleSubagentRows(rows);

    expect(pill.segments).toEqual([{ bucket: "failed", text: "2 failed" }]);
    expect(visible.map((r) => r.id)).toEqual(["failed-1", "failed-2"]);
    expect(visible.length).toBe(totalPillCount);
  });

  it("shows every row once nothing is active, matching the pill's total label", () => {
    const rows = [row({ id: "a", status: "idle" }), row({ id: "b", status: "idle" })];
    const pill = buildSubagentPillPresentation(i18n.t, rows);
    const visible = selectVisibleSubagentRows(rows);

    expect(pill.segments).toEqual([{ bucket: null, text: "2 subagents" }]);
    expect(visible.length).toBe(rows.length);
  });

  it("keeps only the active states when the fan-out mixes failed, working, and done children", () => {
    const rows = [
      row({ id: "failed", status: "error" }),
      row({ id: "working", status: "running" }),
      row({ id: "done", status: "idle" }),
    ];
    const visible = selectVisibleSubagentRows(rows);
    expect(visible.map((r) => r.id).sort()).toEqual(["failed", "working"]);
  });
});

describe("countFinishedSubagents", () => {
  it("counts eligible managed and terminal provider-owned children", () => {
    const providerRows: SubagentRow[] = [
      {
        kind: "provider",
        id: "native-running",
        parentAgentId: "parent",
        provider: "claude",
        title: "running",
        description: null,
        subtitle: null,
        status: "running",
        requiresAttention: false,
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
      },
      {
        kind: "provider",
        id: "native-failed",
        parentAgentId: "parent",
        provider: "claude",
        title: "failed",
        description: null,
        subtitle: null,
        status: "failed",
        requiresAttention: true,
        createdAt: new Date("2026-04-20T00:00:01.000Z"),
      },
    ];

    expect(
      countFinishedSubagents([
        row({ id: "managed-running", status: "running" }),
        row({ id: "managed-idle", status: "idle" }),
        ...providerRows,
      ]),
    ).toBe(2);
  });

  it("excludes running and initializing managed children", () => {
    expect(
      countFinishedSubagents([
        row({ id: "running", status: "running" }),
        row({ id: "initializing", status: "initializing" }),
        row({ id: "finished", status: "idle" }),
      ]),
    ).toBe(1);
  });
});

describe("resolveRowLabel", () => {
  it("returns null when title is not a string", () => {
    expect(resolveRowLabel(null as unknown as SubagentRow["title"])).toBe(null);
  });

  it("returns null for whitespace-only titles", () => {
    expect(resolveRowLabel("   ")).toBe(null);
  });

  it("returns null for the placeholder 'new agent' regardless of case", () => {
    expect(resolveRowLabel("new agent")).toBe(null);
    expect(resolveRowLabel("New Agent")).toBe(null);
    expect(resolveRowLabel("  NEW AGENT  ")).toBe(null);
  });

  it("returns the trimmed title for real names", () => {
    expect(resolveRowLabel("  Build the thing  ")).toBe("Build the thing");
  });
});

describe("buildSubagentRowPresentationData", () => {
  it("namespaces the key with a subagent prefix", () => {
    expect(buildSubagentRowPresentationData(row({ id: "child-a" })).key).toBe(
      "paseo_subagent_child-a",
    );
  });

  it("marks the row ready when the title resolves to a real label", () => {
    const presentation = buildSubagentRowPresentationData(row({ id: "a", title: "Build it" }));
    expect(presentation.titleState).toBe("ready");
    expect(presentation.label).toBe("Build it");
  });

  it("marks the row loading and blanks the label for the placeholder title", () => {
    const presentation = buildSubagentRowPresentationData(row({ id: "a", title: "new agent" }));
    expect(presentation.titleState).toBe("loading");
    expect(presentation.label).toBe("");
  });

  it("maps a running row to the running status bucket so callers render the synced loader", () => {
    expect(buildSubagentRowPresentationData(row({ id: "a", status: "running" })).statusBucket).toBe(
      "running",
    );
  });

  it("maps an idle row to the done status bucket so callers render the static provider icon", () => {
    expect(buildSubagentRowPresentationData(row({ id: "a", status: "idle" })).statusBucket).toBe(
      "done",
    );
  });

  it("maps an idle row with requiresAttention to the attention status bucket", () => {
    expect(
      buildSubagentRowPresentationData(row({ id: "a", status: "idle", requiresAttention: true }))
        .statusBucket,
    ).toBe("attention");
  });

  it("uses the agent's live activity summary as the subtitle when present", () => {
    const presentation = buildSubagentRowPresentationData(
      row({ id: "a", subtitle: "Running the test suite" }),
    );
    expect(presentation.subtitle).toBe("Running the test suite");
  });

  it("falls back to no subtitle for a managed row with no activity summary", () => {
    expect(buildSubagentRowPresentationData(row({ id: "a" })).subtitle).toBe("");
  });
});

describe("buildSubagentRowPresentationData for provider rows", () => {
  function providerRow(overrides: Partial<ProviderSubagentRow> = {}): ProviderSubagentRow {
    return {
      kind: "provider",
      id: overrides.id ?? "toolu_1",
      parentAgentId: "parent",
      provider: "claude",
      title: "title" in overrides ? (overrides.title ?? null) : "general-purpose",
      description: overrides.description ?? null,
      subtitle: overrides.subtitle ?? null,
      status: overrides.status ?? "running",
      requiresAttention: false,
      createdAt: overrides.createdAt ?? new Date("2026-07-26T00:00:00.000Z"),
    };
  }

  it("names the row after the task and demotes the subagent type", () => {
    const presentation = buildSubagentRowPresentationData(
      providerRow({ title: "general-purpose", description: "Reply with banana" }),
    );
    expect(presentation.label).toBe("Reply with banana");
    expect(presentation.subtitle).toBe("general-purpose");
  });

  it("tells two siblings of the same type apart", () => {
    const left = buildSubagentRowPresentationData(
      providerRow({ id: "a", description: "Summarize the docs" }),
    );
    const right = buildSubagentRowPresentationData(
      providerRow({ id: "b", description: "Reply with banana" }),
    );
    expect(left.label).not.toBe(right.label);
  });

  it("keeps type-as-label and an empty subtitle when a provider reports no task", () => {
    const presentation = buildSubagentRowPresentationData(
      providerRow({ title: "Provider child", description: null }),
    );
    expect(presentation.label).toBe("Provider child");
    expect(presentation.subtitle).toBe("");
  });

  it("stays in the loading state when neither field is known", () => {
    const presentation = buildSubagentRowPresentationData(
      providerRow({ title: null, description: null }),
    );
    expect(presentation.titleState).toBe("loading");
  });

  it("leaves managed subagent rows with no subtitle", () => {
    expect(buildSubagentRowPresentationData(row({ id: "a", title: "Managed" })).subtitle).toBe("");
  });
});

describe("provider-owned row subtitles", () => {
  function providerRow(overrides: Partial<ProviderSubagentRow> = {}): ProviderSubagentRow {
    return {
      kind: "provider",
      id: "toolu_1",
      parentAgentId: "parent",
      provider: "claude",
      title: "general-purpose",
      description: "Reply with banana",
      subtitle: null,
      status: "running",
      requiresAttention: false,
      createdAt: new Date("2026-07-26T00:00:00.000Z"),
      ...overrides,
    };
  }

  it("displays provider context without interpreting it", () => {
    expect(
      buildSubagentRowPresentationData(
        providerRow({ subtitle: "general-purpose · Opus 5 · High · 16.5k tokens" }),
      ).subtitle,
    ).toBe("general-purpose · Opus 5 · High · 16.5k tokens");
  });

  it("falls back to the type when an older provider sends no subtitle", () => {
    expect(buildSubagentRowPresentationData(providerRow()).subtitle).toBe("general-purpose");
  });

  it("does not duplicate the type when it is already the primary label", () => {
    expect(
      buildSubagentRowPresentationData(
        providerRow({ description: null, subtitle: null, title: "general-purpose" }),
      ).subtitle,
    ).toBe("");
  });
});
