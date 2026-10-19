import { Platform } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveScrollIndicatorFade } from "./scroll-indicator-fade";

// The real module's web entry point constructs a JSReanimated instance at import time, reading
// `__DEV__` before vitest.setup.ts's assignment is visible to it (same fix as
// jev-header-badge.test.tsx); `vi.hoisted` runs ahead of every other import in this file.
vi.hoisted(() => {
  (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = false;
});

describe("resolveScrollIndicatorFade", () => {
  const originalOS = Platform.OS;

  afterEach(() => {
    Platform.OS = originalOS;
  });

  it("disables entering and exiting on Android (react-native-reanimated#8422)", () => {
    Platform.OS = "android";
    expect(resolveScrollIndicatorFade()).toEqual({ fadeIn: undefined, fadeOut: undefined });
  });

  it.each(["ios", "web"] as const)("fades in and out on %s", (os) => {
    Platform.OS = os;
    const { fadeIn, fadeOut } = resolveScrollIndicatorFade();
    expect(fadeIn).toBeDefined();
    expect(fadeOut).toBeDefined();
  });
});
