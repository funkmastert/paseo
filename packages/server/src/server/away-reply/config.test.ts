import { describe, expect, it } from "vitest";

import { jevConfigIssues, resolveJevConfig } from "../jev/config.js";
import { createTestJevService } from "../jev/fake.js";
import { AWAY_REPLY_DEFAULTS, resolveAwayReplyConfig } from "./config.js";

describe("agents.jev.awayReply", () => {
  it("starts in dry run, like every JEV feature (D6)", () => {
    expect(resolveAwayReplyConfig(undefined)).toEqual(AWAY_REPLY_DEFAULTS);
    expect(AWAY_REPLY_DEFAULTS).toMatchObject({
      enabled: true,
      dryRun: true,
      shadow: true,
      thresholdMinutes: 60,
      destructiveThreshold: 0.05,
    });
  });

  it("reads dryRun as the service's shadow switch, and dryRun: false as Tyler's go-live", () => {
    expect(resolveAwayReplyConfig({ dryRun: true })).toMatchObject({ dryRun: true, shadow: true });
    expect(resolveAwayReplyConfig({ dryRun: false })).toMatchObject({
      dryRun: false,
      shadow: false,
    });
  });

  it("never lets config raise the destructive-intent threshold past 0.05", () => {
    expect(resolveAwayReplyConfig({ destructiveThreshold: 0.9 }).destructiveThreshold).toBe(0.05);
    expect(resolveAwayReplyConfig({ destructiveThreshold: 0.2 }).destructiveThreshold).toBe(0.05);
    expect(resolveAwayReplyConfig({ destructiveThreshold: 0.01 }).destructiveThreshold).toBe(0.01);
    expect(resolveAwayReplyConfig({ destructiveThreshold: -1 }).destructiveThreshold).toBe(0.05);
  });

  it("falls back to defaults for malformed values", () => {
    expect(
      resolveAwayReplyConfig({ thresholdMinutes: "soon", maxRepliesPerDay: 0, enabled: "yes" }),
    ).toMatchObject({ thresholdMinutes: 60, maxRepliesPerDay: 12, enabled: true });
  });

  it("rides in the JEV config and in the service's status", () => {
    expect(resolveJevConfig({}, { homeDir: "/tmp" }).awayReply).toEqual(AWAY_REPLY_DEFAULTS);
    const jev = createTestJevService();
    expect(jev.status().features.awayReply).toEqual({ enabled: true, shadow: true });
    const live = createTestJevService({ config: { awayReply: { dryRun: false } } });
    expect(live.status().features.awayReply).toEqual({ enabled: true, shadow: false });
  });

  it("is accepted by JEV's strict schema, and unknown keys are not", () => {
    // `agents.jev` loads whatever it holds; JEV itself checks it against `AgentJevSchema`, and a
    // section that breaks it turns JEV off rather than guessing.
    expect(
      jevConfigIssues({
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
      }),
    ).toEqual([]);
    expect(jevConfigIssues({ awayReply: { shadow: true } })).not.toEqual([]);
    expect(jevConfigIssues({ awayReply: { destructiveThreshold: 0.8 } })).not.toEqual([]);
  });
});
