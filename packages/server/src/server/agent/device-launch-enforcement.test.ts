import { describe, expect, test } from "vitest";
import {
  describeDeviceLaunchEnforcement,
  resolveDeviceLaunchEnforcement,
  resolveProviderExtends,
} from "./device-launch-enforcement.js";

describe("resolveDeviceLaunchEnforcement", () => {
  test("names the mechanism for every provider the daemon can refuse outright, with nothing left to confess", () => {
    expect(resolveDeviceLaunchEnforcement("claude")).toMatchObject({ tier: "refuses" });
    expect(resolveDeviceLaunchEnforcement("opencode")).toMatchObject({ tier: "refuses" });
    expect(resolveDeviceLaunchEnforcement("claude").gap).toBeUndefined();
    expect(resolveDeviceLaunchEnforcement("opencode").gap).toBeUndefined();
  });

  test("Codex refuses, but only in guarded mode -- the one refuses tier with something left to confess", () => {
    const codex = resolveDeviceLaunchEnforcement("codex");
    expect(codex.tier).toBe("refuses");
    expect(codex.gap).toContain("guarded");
  });

  test("a provider the daemon can only ask says so, and says where the hole is", () => {
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

describe("resolveProviderExtends", () => {
  test("reads extends off a claude-backup-style provider entry", () => {
    const providers = { "claude-backup": { extends: "claude" } };
    expect(resolveProviderExtends("claude-backup", providers)).toBe("claude");
    // Which is what makes it enforce like claude, not like an unknown provider.
    expect(
      resolveDeviceLaunchEnforcement(
        "claude-backup",
        resolveProviderExtends("claude-backup", providers),
      ).tier,
    ).toBe("refuses");
  });

  test("a provider entry with no extends resolves to undefined", () => {
    expect(resolveProviderExtends("claude", { claude: {} })).toBeUndefined();
  });

  test("a provider id absent from the config resolves to undefined", () => {
    expect(resolveProviderExtends("claude-backup", {})).toBeUndefined();
    expect(resolveProviderExtends("claude-backup", undefined)).toBeUndefined();
    expect(
      resolveProviderExtends(undefined, { "claude-backup": { extends: "claude" } }),
    ).toBeUndefined();
  });

  test("a malformed provider entry fails closed to undefined rather than throwing", () => {
    expect(
      resolveProviderExtends("claude-backup", { "claude-backup": "not-an-object" }),
    ).toBeUndefined();
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

  test("tells a refused agent where its guard stops applying, even on the refuses tier", () => {
    const text = describeDeviceLaunchEnforcement(resolveDeviceLaunchEnforcement("codex"));
    expect(text).toContain("refused");
    expect(text).toContain("guarded");
    expect(text).toContain("device_checkout");
  });
});
