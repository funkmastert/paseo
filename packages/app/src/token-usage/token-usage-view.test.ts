import { describe, expect, it } from "vitest";
import { resolveTokenUsageAvailability } from "./token-usage-view";

describe("resolveTokenUsageAvailability", () => {
  it("is no-host without a host, even connected", () => {
    expect(
      resolveTokenUsageAvailability({ hasHost: false, connected: true, supported: true }),
    ).toEqual({ kind: "no-host" });
  });

  it("is connecting for a host that hasn't connected yet", () => {
    expect(
      resolveTokenUsageAvailability({ hasHost: true, connected: false, supported: true }),
    ).toEqual({ kind: "connecting" });
  });

  it("is update-host when the feature is unsupported", () => {
    expect(
      resolveTokenUsageAvailability({ hasHost: true, connected: true, supported: false }),
    ).toEqual({ kind: "update-host" });
  });

  it("is ready when connected and supported", () => {
    expect(
      resolveTokenUsageAvailability({ hasHost: true, connected: true, supported: true }),
    ).toEqual({ kind: "ready" });
  });
});
