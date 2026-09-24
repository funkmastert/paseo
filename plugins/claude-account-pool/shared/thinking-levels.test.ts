import { describe, expect, it } from "vitest";
import {
  THINKING_LEVEL_IDS,
  THINKING_LEVEL_LABELS,
  ULTRACODE_EFFORT_OPTION_ID,
  ULTRACODE_OPTION_ID,
  clampThinkingOption,
} from "./thinking-levels";

describe("THINKING_LEVEL_IDS / THINKING_LEVEL_LABELS", () => {
  it("orders the known levels by effort, Ultra Code last", () => {
    expect(THINKING_LEVEL_IDS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultracode"]);
  });

  it("labels every known id", () => {
    expect(THINKING_LEVEL_LABELS).toEqual({
      off: "Off",
      minimal: "Minimal",
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "Extra High",
      max: "Max",
      ultracode: "Ultra Code",
    });
  });
});

describe("Ultra Code", () => {
  it("is its own option id, running at Extra High's effort", () => {
    expect(ULTRACODE_OPTION_ID).toBe("ultracode");
    expect(ULTRACODE_EFFORT_OPTION_ID).toBe("xhigh");
  });
});

describe("clampThinkingOption", () => {
  const OFF_TO_MAX = ["off", "low", "medium", "high", "max"];

  it("returns the wanted id unclamped when the model advertises it", () => {
    expect(clampThinkingOption("high", OFF_TO_MAX, "high")).toEqual({ optionId: "high", how: "unclamped" });
  });

  it("clamps xhigh down to the nearest lower level a model without xhigh offers", () => {
    // Opus 4.6 / Sonnet 4.6 shape: off/low/medium/high/max, no xhigh.
    expect(clampThinkingOption("xhigh", OFF_TO_MAX, "high")).toEqual({ optionId: "high", how: "nearest-lower" });
  });

  it("clamps ultracode to the highest effort a model without it offers — only a leader ever wants it", () => {
    expect(clampThinkingOption("ultracode", OFF_TO_MAX, "high")).toEqual({ optionId: "max", how: "highest-effort" });
    expect(clampThinkingOption("ultracode", ["off", "low", "medium", "high"], "high")).toEqual({
      optionId: "high",
      how: "highest-effort",
    });
  });

  it("never lands on ultracode as a fallback: it is a mode, not a rung above max", () => {
    // A model offering nothing but Low and Ultra Code: Max is wanted, and the
    // only level "above" it on paper is Ultra Code. Low is what is applied.
    expect(clampThinkingOption("max", ["low", "ultracode"], "low")).toEqual({ optionId: "low", how: "nearest-lower" });
    expect(clampThinkingOption("off", ["ultracode", "high"], "high")).toEqual({ optionId: "high", how: "nearest-higher" });
  });

  it("clamps off up to the nearest higher level on a model that cannot disable thinking", () => {
    // Opus 5.5 shape: low/medium/high/xhigh/max/ultracode, no off.
    const opus55 = ["low", "medium", "high", "xhigh", "max", "ultracode"];
    expect(clampThinkingOption("off", opus55, "high")).toEqual({ optionId: "low", how: "nearest-higher" });
  });

  it("falls back to the model's own default when the wanted id isn't on the ladder at all", () => {
    expect(clampThinkingOption("banana", OFF_TO_MAX, "high")).toEqual({ optionId: "high", how: "model-default" });
  });

  it("falls back to the model's first advertised option when there is no default id and the wanted id isn't on the ladder", () => {
    expect(clampThinkingOption("banana", OFF_TO_MAX, undefined)).toEqual({ optionId: "off", how: "model-default" });
  });

  it("never returns a default the model doesn't advertise", () => {
    expect(clampThinkingOption("banana", ["a", "b"], "c")).toEqual({ optionId: "a", how: "model-default" });
  });

  it("falls back to model-default when none of the advertised ids are on the ladder either", () => {
    expect(clampThinkingOption("high", ["custom-reasoning-mode"], "custom-reasoning-mode")).toEqual({
      optionId: "custom-reasoning-mode",
      how: "model-default",
    });
  });
});
