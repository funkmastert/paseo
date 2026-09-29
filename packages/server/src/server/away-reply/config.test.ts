import { describe, expect, it } from "vitest";

import { resolveJevConfig } from "../jev/config.js";
import { createTestJevService } from "../jev/fake.js";
import { PersistedConfigSchema } from "../persisted-config.js";
import { AWAY_REPLY_DEFAULTS, resolveAwayReplyConfig } from "./config.js";

describe("agents.jev.awayReply", () => {
  it("is live by default, not shadow (D10)", () => {
    expect(resolveAwayReplyConfig(undefined)).toEqual(AWAY_REPLY_DEFAULTS);
    expect(AWAY_REPLY_DEFAULTS).toMatchObject({
      enabled: true,
      dryRun: false,
      shadow: false,
      thresholdMinutes: 60,
    });
  });

  it("reads dryRun as the service's shadow switch", () => {
    expect(resolveAwayReplyConfig({ dryRun: true })).toMatchObject({ dryRun: true, shadow: true });
  });

  it("never lets config raise the destructive-intent threshold past 0.5", () => {
    expect(resolveAwayReplyConfig({ destructiveThreshold: 0.9 }).destructiveThreshold).toBe(0.5);
    expect(resolveAwayReplyConfig({ destructiveThreshold: 0.1 }).destructiveThreshold).toBe(0.1);
    expect(resolveAwayReplyConfig({ destructiveThreshold: -1 }).destructiveThreshold).toBe(0.2);
  });

  it("falls back to defaults for malformed values", () => {
    expect(
      resolveAwayReplyConfig({ thresholdMinutes: "soon", maxRepliesPerDay: 0, enabled: "yes" }),
    ).toMatchObject({ thresholdMinutes: 60, maxRepliesPerDay: 12, enabled: true });
  });

  it("rides in the JEV config and in the service's status", () => {
    expect(resolveJevConfig({}, { homeDir: "/tmp" }).awayReply).toEqual(AWAY_REPLY_DEFAULTS);
    const jev = createTestJevService();
    expect(jev.status().features.awayReply).toEqual({ enabled: true, shadow: false });
    const dry = createTestJevService({ config: { awayReply: { dryRun: true } } });
    expect(dry.status().features.awayReply).toEqual({ enabled: true, shadow: true });
  });

  it("is accepted by the strict config schema, and unknown keys are not", () => {
    const accepted = PersistedConfigSchema.safeParse({
      agents: {
        jev: {
          awayReply: {
            enabled: true,
            dryRun: true,
            timeoutMs: 5000,
            thresholdMinutes: 90,
            maxRepliesPerAgentPerDay: 2,
            maxRepliesPerDay: 6,
            destructiveThreshold: 0.1,
            approveReadOnlyPermissions: false,
            skipPinnedWorkspaces: true,
          },
        },
      },
    });
    expect(accepted.success).toBe(true);
    expect(
      PersistedConfigSchema.safeParse({ agents: { jev: { awayReply: { shadow: true } } } }).success,
    ).toBe(false);
    expect(
      PersistedConfigSchema.safeParse({
        agents: { jev: { awayReply: { destructiveThreshold: 0.8 } } },
      }).success,
    ).toBe(false);
  });
});
