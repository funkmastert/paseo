import { describe, expect, test } from "vitest";
import type {
  NotifyAvailabilityMode,
  NotifyLevel,
  NotifyPolicySettings,
} from "@getpaseo/protocol/notify-policy/types";

import { resolveAvailability } from "./availability.js";
import { decideDelivery } from "./decide.js";
import { DEFAULT_NOTIFY_POLICY_SETTINGS } from "./settings.js";

function outcome(
  level: NotifyLevel,
  mode: NotifyAvailabilityMode,
  dials: Partial<NotifyPolicySettings> = {},
) {
  const settings: NotifyPolicySettings = {
    ...DEFAULT_NOTIFY_POLICY_SETTINGS,
    ...dials,
    availability: { mode, until: null },
  };
  return decideDelivery({ level, settings, availability: resolveAvailability(settings, 0) })
    .outcome;
}

const MODES = ["available", "focus", "away", "off"] as const;

function rowFor(level: NotifyLevel): string[] {
  const row: string[] = [];
  for (const mode of MODES) row.push(outcome(level, mode));
  return row;
}

describe("decideDelivery", () => {
  test("with default dials", () => {
    // columns: available, focus, away, off
    expect(rowFor("record")).toEqual(["log", "log", "log", "log"]);
    expect(rowFor("notice")).toEqual(["digest", "digest", "digest", "digest"]);
    expect(rowFor("alert")).toEqual(["interrupt", "notify", "interrupt", "notify"]);
    expect(rowFor("urgent")).toEqual(["interrupt", "interrupt", "interrupt", "notify"]);
  });

  test("the interrupt dial moves the line between digest and interrupt", () => {
    expect(outcome("notice", "available", { minInterruptLevel: "notice" })).toBe("interrupt");
    expect(outcome("alert", "available", { minInterruptLevel: "urgent" })).toBe("digest");
  });

  test("the post dial moves the line between log and the rest", () => {
    expect(outcome("notice", "available", { minPostLevel: "alert" })).toBe("log");
    expect(outcome("record", "available", { minPostLevel: "record" })).toBe("digest");
  });
});

describe("resolveAvailability", () => {
  const settings = (until: string | null): NotifyPolicySettings => ({
    ...DEFAULT_NOTIFY_POLICY_SETTINGS,
    availability: { mode: "focus", until },
  });

  test("a mode without an end time lasts until it is changed", () => {
    expect(resolveAvailability(settings(null), Date.now()).mode).toBe("focus");
  });

  test("a mode whose end time has passed no longer applies", () => {
    const until = "2026-09-23T12:00:00.000Z";
    expect(resolveAvailability(settings(until), Date.parse(until) - 1).mode).toBe("focus");
    expect(resolveAvailability(settings(until), Date.parse(until)).mode).toBe("available");
  });
});
