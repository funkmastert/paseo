import { describe, expect, test } from "vitest";
import {
  describeDeviceLaunchEnforcement,
  resolveDeviceLaunchEnforcement,
} from "./device-launch-enforcement.js";

describe("resolveDeviceLaunchEnforcement", () => {
  test("names the mechanism for every provider the daemon can refuse outright", () => {
    expect(resolveDeviceLaunchEnforcement("claude")).toMatchObject({ tier: "refuses" });
    expect(resolveDeviceLaunchEnforcement("opencode")).toMatchObject({ tier: "refuses" });
    // A tier that refuses has nothing left to confess.
    expect(resolveDeviceLaunchEnforcement("claude").gap).toBeUndefined();
    expect(resolveDeviceLaunchEnforcement("opencode").gap).toBeUndefined();
  });

  test("a provider the daemon can only ask says so, and says where the hole is", () => {
    const codex = resolveDeviceLaunchEnforcement("codex");
    expect(codex.tier).toBe("asks");
    expect(codex.gap).toContain("Full Access");

    for (const provider of ["copilot", "cursor", "kimi", "kiro", "traecli", "omp"]) {
      const enforcement = resolveDeviceLaunchEnforcement(provider);
      expect(enforcement.tier, provider).toBe("asks");
      expect(enforcement.gap, provider).toBeTruthy();
    }
  });

  test("Pi cannot be stopped at all, and the tier says that rather than implying a gate", () => {
    const pi = resolveDeviceLaunchEnforcement("pi");
    expect(pi.tier).toBe("observes");
    expect(pi.mechanism).toContain("nothing");
  });

  test("a provider nobody has checked is observes, never something stronger", () => {
    // Overstating the cap is the failure that makes the whole feature untrustworthy, so an
    // unknown provider gets the weakest tier rather than a guess from its name.
    expect(resolveDeviceLaunchEnforcement("something-new").tier).toBe("observes");
    expect(resolveDeviceLaunchEnforcement(undefined).tier).toBe("observes");
  });

  test("a derived provider inherits its base's tier — a second Claude account is still gated", () => {
    expect(resolveDeviceLaunchEnforcement("claude-work", "claude").tier).toBe("refuses");
    expect(resolveDeviceLaunchEnforcement("my-pi", "pi").tier).toBe("observes");
  });

  test("a custom ACP provider is gated like the ACP providers it shares a client with", () => {
    expect(resolveDeviceLaunchEnforcement("some-acp-agent", "acp").tier).toBe("asks");
  });
});

describe("describeDeviceLaunchEnforcement", () => {
  test("tells a refused agent that checking out avoids the refusal", () => {
    const text = describeDeviceLaunchEnforcement(resolveDeviceLaunchEnforcement("claude"));
    expect(text).toContain("refused");
    expect(text).toContain("device_checkout");
  });

  test("tells an unguarded agent that checkout is the only thing holding the cap", () => {
    const text = describeDeviceLaunchEnforcement(resolveDeviceLaunchEnforcement("pi"));
    expect(text).toContain("Nothing refuses");
    expect(text).toContain("only thing holding the cap");
  });

  test("tells a partially guarded agent where its gate stops applying", () => {
    const text = describeDeviceLaunchEnforcement(resolveDeviceLaunchEnforcement("codex"));
    expect(text).toContain("Full Access");
    expect(text).toContain("device_checkout");
  });
});
