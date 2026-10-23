import { describe, expect, it } from "vitest";
import {
  buildRemediationEscalatedNotificationPayload,
  buildRemediationRecordNotificationPayload,
  describeRemediationAttempts,
} from "./remediation-notification.js";

const attempt = (detail: string) => ({ remedy: "reaper", outcome: "acted", detail });

describe("buildRemediationEscalatedNotificationPayload", () => {
  it("says what is wrong, what was tried, and how the agent ended", () => {
    const payload = buildRemediationEscalatedNotificationPayload({
      serverId: "srv",
      key: "orphan-build-daemons",
      kind: "orphan-build-daemons",
      title: "Orphaned build daemons",
      summary: "3 daemons hold 6.1 GB.",
      attempts: [attempt("reaped pid 12 (1.2 GB)")],
      outcome: "REMEDIATION: NOT_FIXED — they respawn from a stuck Gradle build",
      agentId: "agent-1",
    });
    expect(payload.title).toBe("Needs you: Orphaned build daemons");
    expect(payload.body).toBe(
      "3 daemons hold 6.1 GB. Tried: reaper acted: reaped pid 12 (1.2 GB). REMEDIATION: NOT_FIXED — they respawn from a stuck Gradle build",
    );
    expect(payload.data).toEqual({
      serverId: "srv",
      reason: "remediation_escalated",
      key: "orphan-build-daemons",
      kind: "orphan-build-daemons",
      agentId: "agent-1",
    });
  });

  it("lists the newest three attempts and counts the rest", () => {
    const payload = buildRemediationEscalatedNotificationPayload({
      serverId: "srv",
      key: "k",
      kind: "disk-low",
      title: "Disk low",
      summary: "12 GB free.",
      attempts: ["a", "b", "c", "d", "e"].map(attempt),
      outcome: "Escalation is disabled.",
    });
    expect(payload.body).toBe(
      "12 GB free. Tried: reaper acted: c; reaper acted: d; reaper acted: e (and 2 earlier). Escalation is disabled.",
    );
    expect(payload.data.agentId).toBeUndefined();
  });
});

describe("buildRemediationRecordNotificationPayload", () => {
  it("prefixes the title by event and carries the reason", () => {
    const payload = buildRemediationRecordNotificationPayload({
      serverId: "srv",
      key: "k",
      kind: "disk-low",
      title: "Disk low",
      event: "agent_started",
      detail: "agent abc",
      workspaceId: "ws",
    });
    expect(payload.title).toBe("Agent working on: Disk low");
    expect(payload.data.reason).toBe("remediation_agent_started");
    expect(payload.data.workspaceId).toBe("ws");
  });

  it("describes an empty attempt list", () => {
    expect(describeRemediationAttempts([])).toBe("No remedy ran.");
  });
});
