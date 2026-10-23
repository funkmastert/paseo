import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginHookContext } from "@getpaseo/plugin/server";
import { createModelCatalogCache, type ProvidersModelsApi } from "./model-catalog";

function fakeModel(id: string, extra: Record<string, unknown> = {}) {
  return { provider: "claude", id, label: id, ...extra };
}

function fakeProvidersApi(byFamily: Record<string, string[]>) {
  const listModels = vi.fn(async (provider: string) => ({
    provider,
    models: (byFamily[provider] ?? []).map((id) => fakeModel(id)),
    fetchedAt: "now",
    requestId: "r1",
  }));
  return {
    providers: { listModels } as unknown as PluginHookContext["paseo"]["providers"],
    listModels,
  };
}

/** Like `fakeProvidersApi`, but each model can carry its own `thinkingOptions`/`defaultThinkingOptionId`. */
function fakeProvidersApiWithModels(byFamily: Record<string, ReturnType<typeof fakeModel>[]>) {
  const listModels = vi.fn(async (provider: string) => ({
    provider,
    models: byFamily[provider] ?? [],
    fetchedAt: "now",
    requestId: "r1",
  }));
  return {
    providers: { listModels } as unknown as PluginHookContext["paseo"]["providers"],
    listModels,
  };
}

describe("createModelCatalogCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts empty before the first load resolves", () => {
    const { providers } = fakeProvidersApi({ claude: ["claude-opus-4"] });
    const cache = createModelCatalogCache({ providers } as ProvidersModelsApi, () => ["claude"], {
      intervalMs: 1000,
    });

    expect(cache.get()).toEqual(new Map());
    cache.stop();
  });

  it("refreshes on interval ticks, building Map<family, Set<modelId>>", async () => {
    const { providers } = fakeProvidersApi({ claude: ["claude-opus-4", "claude-sonnet-4"], codex: ["gpt-5.1"] });
    const cache = createModelCatalogCache({ providers } as ProvidersModelsApi, () => ["claude", "codex"], {
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(cache.get()).toEqual(
      new Map([
        ["claude", new Set(["claude-opus-4", "claude-sonnet-4"])],
        ["codex", new Set(["gpt-5.1"])],
      ]),
    );
    cache.stop();
  });

  it("refreshes immediately on forceRefresh without waiting for the interval", async () => {
    const { providers } = fakeProvidersApi({ claude: ["claude-opus-4"] });
    const cache = createModelCatalogCache({ providers } as ProvidersModelsApi, () => ["claude"], {
      intervalMs: 60_000,
    });

    const result = await cache.forceRefresh();

    expect(result).toEqual(new Map([["claude", new Set(["claude-opus-4"])]]));
    cache.stop();
  });

  it("re-reads getFamilies() on every poll, picking up a newly configured family", async () => {
    const { providers } = fakeProvidersApi({ claude: ["claude-opus-4"], codex: ["gpt-5.1"] });
    let families: readonly string[] = ["claude"];
    const cache = createModelCatalogCache({ providers } as ProvidersModelsApi, () => families, {
      intervalMs: 1000,
    });

    await cache.forceRefresh();
    expect(cache.get().has("codex")).toBe(false);

    families = ["claude", "codex"];
    await cache.forceRefresh();

    expect(cache.get().get("codex")).toEqual(new Set(["gpt-5.1"]));
    cache.stop();
  });

  it("keeps a family's last-known set on a transient listModels failure instead of dropping it", async () => {
    const { providers, listModels } = fakeProvidersApi({ claude: ["claude-opus-4"] });
    const cache = createModelCatalogCache({ providers } as ProvidersModelsApi, () => ["claude"], {
      intervalMs: 1000,
    });

    await cache.forceRefresh();
    expect(cache.get().get("claude")).toEqual(new Set(["claude-opus-4"]));

    listModels.mockRejectedValueOnce(new Error("provider unavailable"));
    await cache.forceRefresh();

    expect(cache.get().get("claude")).toEqual(new Set(["claude-opus-4"]));
    cache.stop();
  });

  it("stop() clears the interval so no further refreshes happen", async () => {
    const { providers, listModels } = fakeProvidersApi({ claude: ["claude-opus-4"] });
    const cache = createModelCatalogCache({ providers } as ProvidersModelsApi, () => ["claude"], {
      intervalMs: 1000,
    });
    cache.stop();

    const callsAtStop = listModels.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);

    expect(listModels.mock.calls.length).toBe(callsAtStop);
  });

  describe("getThinking()", () => {
    it("starts empty before the first load resolves", () => {
      const { providers } = fakeProvidersApi({ claude: ["claude-opus-4"] });
      const cache = createModelCatalogCache({ providers } as ProvidersModelsApi, () => ["claude"], {
        intervalMs: 1000,
      });

      expect(cache.getThinking()).toEqual(new Map());
      cache.stop();
    });

    it("records each model's thinking options and its default", async () => {
      const { providers } = fakeProvidersApiWithModels({
        claude: [
          fakeModel("claude-opus-5-5", {
            thinkingOptions: [
              { id: "low", label: "Low" },
              { id: "high", label: "High", isDefault: true },
              { id: "ultracode", label: "Ultra Code" },
            ],
            defaultThinkingOptionId: "high",
          }),
        ],
      });
      const cache = createModelCatalogCache({ providers } as ProvidersModelsApi, () => ["claude"], {
        intervalMs: 1000,
      });

      await cache.forceRefresh();

      expect(cache.getThinking()).toEqual(
        new Map([
          [
            "claude",
            new Map([["claude-opus-5-5", { optionIds: ["low", "high", "ultracode"], defaultOptionId: "high" }]]),
          ],
        ]),
      );
      cache.stop();
    });

    it("falls back to an option's own isDefault flag when defaultThinkingOptionId is absent", async () => {
      const { providers } = fakeProvidersApiWithModels({
        claude: [
          fakeModel("claude-sonnet-4-6", {
            thinkingOptions: [
              { id: "off", label: "Off" },
              { id: "high", label: "High", isDefault: true },
            ],
          }),
        ],
      });
      const cache = createModelCatalogCache({ providers } as ProvidersModelsApi, () => ["claude"], {
        intervalMs: 1000,
      });

      await cache.forceRefresh();

      expect(cache.getThinking().get("claude")?.get("claude-sonnet-4-6")).toEqual({
        optionIds: ["off", "high"],
        defaultOptionId: "high",
      });
      cache.stop();
    });

    it("gives a model with no thinking options optionIds: [] and no defaultOptionId", async () => {
      const { providers } = fakeProvidersApiWithModels({ claude: [fakeModel("claude-haiku-4-5")] });
      const cache = createModelCatalogCache({ providers } as ProvidersModelsApi, () => ["claude"], {
        intervalMs: 1000,
      });

      await cache.forceRefresh();

      expect(cache.getThinking().get("claude")?.get("claude-haiku-4-5")).toEqual({ optionIds: [] });
      cache.stop();
    });

    it("keeps a family's last-known thinking entry on a transient listModels failure instead of dropping it", async () => {
      const { providers, listModels } = fakeProvidersApiWithModels({
        claude: [fakeModel("claude-opus-5-5", { thinkingOptions: [{ id: "high", label: "High" }] })],
      });
      const cache = createModelCatalogCache({ providers } as ProvidersModelsApi, () => ["claude"], {
        intervalMs: 1000,
      });

      await cache.forceRefresh();
      expect(cache.getThinking().get("claude")?.get("claude-opus-5-5")).toEqual({ optionIds: ["high"] });

      listModels.mockRejectedValueOnce(new Error("provider unavailable"));
      await cache.forceRefresh();

      expect(cache.getThinking().get("claude")?.get("claude-opus-5-5")).toEqual({ optionIds: ["high"] });
      cache.stop();
    });
  });
});
