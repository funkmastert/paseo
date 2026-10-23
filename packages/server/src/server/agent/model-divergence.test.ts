import { describe, expect, test } from "vitest";
import {
  MODEL_TRANSITION_GRACE_MS,
  canonicalModelId,
  divergenceKey,
  emptyModelDivergenceState,
  isDivergencePersisting,
  noteConfiguredModelChange,
  noteSessionRestart,
  recordModelObservation,
  resolveModelReference,
  type ModelDivergenceState,
} from "./model-divergence.js";

const T0 = 1_000_000;

function observe(
  state: ModelDivergenceState,
  input: {
    observed: string;
    at?: number;
    configured?: string | null;
    init?: string | null;
  },
): ModelDivergenceState {
  return recordModelObservation(state, {
    observedModel: input.observed,
    at: input.at ?? T0,
    configuredModel: input.configured === undefined ? "claude-sonnet-5" : input.configured,
    initModel: input.init,
  });
}

describe("canonicalModelId", () => {
  test("treats a context-window suffix, a dated snapshot and dotted versions as one model", () => {
    expect(canonicalModelId("claude-opus-4-8[1m]")).toBe("claude-opus-4-8");
    expect(canonicalModelId("claude-sonnet-5-20260101")).toBe("claude-sonnet-5");
    expect(canonicalModelId("Claude-Opus-4.8")).toBe("claude-opus-4-8");
  });

  test("keeps claude-opus-5-5 distinct from claude-opus-5", () => {
    // The manifest normalizer collapses the first onto the second; a comparison built on it
    // could never see an Opus 5.5 agent served by Opus 5.
    expect(canonicalModelId("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(canonicalModelId("claude-opus-5-5")).not.toBe(canonicalModelId("claude-opus-5"));
  });

  test("returns null for a placeholder or an empty value", () => {
    expect(canonicalModelId("<synthetic>")).toBeNull();
    expect(canonicalModelId("  ")).toBeNull();
    expect(canonicalModelId(undefined)).toBeNull();
  });
});

describe("resolveModelReference", () => {
  test("a concrete id is its own reference and ignores the init model", () => {
    expect(
      resolveModelReference({ configuredModel: "claude-opus-5-5", initModel: "claude-opus-5" }),
    ).toEqual({ kind: "model", model: "claude-opus-5-5" });
  });

  test("an alias resolves through the init model", () => {
    expect(
      resolveModelReference({ configuredModel: "opus[1m]", initModel: "claude-opus-4-8[1m]" }),
    ).toEqual({ kind: "model", model: "claude-opus-4-8" });
  });

  test("an alias with no resolution yet, a mixed alias and no model are unverifiable", () => {
    expect(resolveModelReference({ configuredModel: "opus" }).kind).toBe("unverifiable");
    expect(
      resolveModelReference({ configuredModel: "opusplan", initModel: "claude-opus-4-8" }).kind,
    ).toBe("unverifiable");
    expect(resolveModelReference({ configuredModel: undefined }).kind).toBe("unverifiable");
  });
});

describe("recordModelObservation", () => {
  test("a response on the configured model is no finding", () => {
    const state = observe(emptyModelDivergenceState(), { observed: "claude-sonnet-5" });
    expect(state.divergence).toBeUndefined();
    expect(state.observedModel).toBe("claude-sonnet-5");
  });

  test("[1m] and a dated snapshot of the configured model are no finding", () => {
    expect(
      observe(emptyModelDivergenceState(), {
        observed: "claude-opus-4-8",
        configured: "claude-opus-4-8[1m]",
      }).divergence,
    ).toBeUndefined();
    expect(
      observe(emptyModelDivergenceState(), {
        observed: "claude-sonnet-5-20260101",
      }).divergence,
    ).toBeUndefined();
  });

  test("an alias that resolved to what the responses report is no finding", () => {
    const state = observe(emptyModelDivergenceState(), {
      observed: "claude-opus-4-8",
      configured: "opus[1m]",
      init: "claude-opus-4-8[1m]",
    });
    expect(state.divergence).toBeUndefined();
  });

  test("a response on another model with nothing to explain it is a finding", () => {
    const state = observe(emptyModelDivergenceState(), { observed: "claude-opus-5" });
    expect(state.divergence).toEqual({
      configuredModel: "claude-sonnet-5",
      observedModel: "claude-opus-5",
      firstObservedAt: T0,
      lastObservedAt: T0,
      responses: 1,
    });
  });

  test("an Opus 5.5 agent served by Opus 5 is a finding, and it is not vouched for by init", () => {
    const state = observe(emptyModelDivergenceState(), {
      observed: "claude-opus-5",
      configured: "claude-opus-5-5",
      init: "claude-opus-5-5",
    });
    expect(state.divergence?.configuredModel).toBe("claude-opus-5-5");
    expect(state.divergence?.observedModel).toBe("claude-opus-5");
  });

  test("an alias whose init resolution disagrees with the responses is a finding", () => {
    const state = observe(emptyModelDivergenceState(), {
      observed: "claude-haiku-4-5",
      configured: "sonnet",
      init: "claude-sonnet-5",
    });
    expect(state.divergence?.configuredModel).toBe("claude-sonnet-5");
  });

  test("an unverifiable configuration never raises a finding", () => {
    for (const configured of ["opusplan", "opus", null]) {
      const state = observe(emptyModelDivergenceState(), {
        observed: "claude-haiku-4-5",
        configured,
      });
      expect(state.divergence).toBeUndefined();
    }
  });

  test("a placeholder frame changes nothing", () => {
    const before = observe(emptyModelDivergenceState(), { observed: "claude-opus-5" });
    expect(observe(before, { observed: "<synthetic>", at: T0 + 1 })).toBe(before);
  });

  test("consecutive responses on the same pair count up; a new pair starts over", () => {
    let state = observe(emptyModelDivergenceState(), { observed: "claude-opus-5", at: T0 });
    state = observe(state, { observed: "claude-opus-5", at: T0 + 30_000 });
    state = observe(state, { observed: "claude-opus-5", at: T0 + 90_000 });
    expect(state.divergence).toMatchObject({
      responses: 3,
      firstObservedAt: T0,
      lastObservedAt: T0 + 90_000,
    });
    state = observe(state, { observed: "claude-haiku-4-5", at: T0 + 100_000 });
    expect(state.divergence).toMatchObject({
      observedModel: "claude-haiku-4-5",
      responses: 1,
      firstObservedAt: T0 + 100_000,
    });
  });

  test("a matching response ends the finding", () => {
    let state = observe(emptyModelDivergenceState(), { observed: "claude-opus-5" });
    state = observe(state, { observed: "claude-sonnet-5", at: T0 + 1 });
    expect(state.divergence).toBeUndefined();
  });
});

describe("intentional changes", () => {
  const changedAt = T0 + 500;

  test("a response from the request in flight when setAgentModel ran is explained", () => {
    // Downgrade opus -> sonnet: the request already streaming still reports opus.
    let state = observe(emptyModelDivergenceState(), {
      observed: "claude-opus-5",
      configured: "claude-opus-5",
    });
    state = noteConfiguredModelChange(state, {
      fromModel: "claude-opus-5",
      toModel: "claude-sonnet-5",
      at: changedAt,
    });
    state = observe(state, {
      observed: "claude-opus-5",
      configured: "claude-sonnet-5",
      at: changedAt + 5_000,
    });
    expect(state.divergence).toBeUndefined();
  });

  test("the first response on the new model ends the transition", () => {
    let state = noteConfiguredModelChange(emptyModelDivergenceState(), {
      fromModel: "claude-opus-5",
      toModel: "claude-sonnet-5",
      at: changedAt,
    });
    state = observe(state, { observed: "claude-sonnet-5", at: changedAt + 5_000 });
    expect(state.transition).toBeUndefined();
    // The old model is a finding from here on.
    state = observe(state, { observed: "claude-opus-5", at: changedAt + 10_000 });
    expect(state.divergence?.observedModel).toBe("claude-opus-5");
  });

  test("the old model is only explained inside the grace window", () => {
    let state = noteConfiguredModelChange(emptyModelDivergenceState(), {
      fromModel: "claude-opus-5",
      toModel: "claude-sonnet-5",
      at: changedAt,
    });
    state = observe(state, {
      observed: "claude-opus-5",
      at: changedAt + MODEL_TRANSITION_GRACE_MS + 1,
    });
    expect(state.divergence).toBeDefined();
  });

  test("a model that is neither the old nor the new one is a finding despite the change", () => {
    let state = noteConfiguredModelChange(emptyModelDivergenceState(), {
      fromModel: "claude-opus-5",
      toModel: "claude-sonnet-5",
      at: changedAt,
    });
    state = observe(state, { observed: "claude-haiku-4-5", at: changedAt + 1_000 });
    expect(state.divergence?.observedModel).toBe("claude-haiku-4-5");
  });

  test("a change drops a finding raised against the previous model", () => {
    let state = observe(emptyModelDivergenceState(), { observed: "claude-opus-5" });
    expect(state.divergence).toBeDefined();
    state = noteConfiguredModelChange(state, {
      fromModel: "claude-sonnet-5",
      toModel: "claude-opus-5",
      at: changedAt,
    });
    expect(state.divergence).toBeUndefined();
  });

  test("the old model is read through the alias's init resolution", () => {
    let state = noteConfiguredModelChange(emptyModelDivergenceState(), {
      fromModel: "opus",
      fromInitModel: "claude-opus-4-8",
      toModel: "claude-sonnet-5",
      at: changedAt,
    });
    state = observe(state, { observed: "claude-opus-4-8", at: changedAt + 1_000 });
    expect(state.divergence).toBeUndefined();
  });

  test("a move to another account clears the finding and any transition", () => {
    let state = observe(emptyModelDivergenceState(), { observed: "claude-opus-5" });
    state = noteSessionRestart(state);
    expect(state.divergence).toBeUndefined();
    expect(state.transition).toBeUndefined();
  });

  test("a response after a move that disagrees with the configured model is still a finding", () => {
    let state = observe(emptyModelDivergenceState(), { observed: "claude-opus-5" });
    state = noteSessionRestart(state);
    state = observe(state, { observed: "claude-opus-5", at: T0 + 60_000 });
    expect(state.divergence?.responses).toBe(1);
  });
});

describe("isDivergencePersisting", () => {
  const thresholds = { persistResponses: 3, persistMs: 60_000 };
  const base = {
    configuredModel: "claude-sonnet-5",
    observedModel: "claude-opus-5",
    firstObservedAt: T0,
  };

  test("needs both enough responses and enough time", () => {
    expect(
      isDivergencePersisting({ ...base, lastObservedAt: T0 + 5_000, responses: 5 }, thresholds),
    ).toBe(false);
    expect(
      isDivergencePersisting({ ...base, lastObservedAt: T0 + 120_000, responses: 2 }, thresholds),
    ).toBe(false);
    expect(
      isDivergencePersisting({ ...base, lastObservedAt: T0 + 60_000, responses: 3 }, thresholds),
    ).toBe(true);
  });
});

describe("divergenceKey", () => {
  test("is the same for the same pair however it is spelled", () => {
    const one = {
      configuredModel: "claude-sonnet-5",
      observedModel: "claude-opus-5[1m]",
      firstObservedAt: 1,
      lastObservedAt: 2,
      responses: 1,
    };
    expect(divergenceKey(one)).toBe(divergenceKey({ ...one, observedModel: "claude-opus-5" }));
    expect(divergenceKey(one)).not.toBe(
      divergenceKey({ ...one, observedModel: "claude-haiku-4-5" }),
    );
  });
});
