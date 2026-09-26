import pino from "pino";
import { describe, expect, it } from "vitest";
import { DaemonDoctorResponseSchema } from "@getpaseo/protocol/doctor/rpc-schemas";
import type { SessionOutboundMessage } from "../../messages.js";
import { DoctorSession } from "./doctor-session.js";
import { makeFixture, poolConfig, writeConfig } from "./test-support.js";

describe("DoctorSession", () => {
  it("answers daemon.doctor.request with schema-valid findings from the daemon's own state", async () => {
    const fx = makeFixture();
    writeConfig(fx, poolConfig(fx));
    const emitted: SessionOutboundMessage[] = [];
    const session = new DoctorSession({
      host: { emit: (msg) => emitted.push(msg) },
      paseoHome: fx.paseoHome,
      home: fx.home,
      daemonVersion: "0.8.0",
      getDaemonStartedAt: async () => new Date().toISOString(),
      listAgents: () => [],
      listWorkspaces: async () => [],
      listPlugins: () => [
        {
          id: "claude-account-pool",
          path: "/x",
          enabled: true,
          status: "failed",
          error: "Invalid URL",
        },
      ],
      getPluginLogs: () => [],
      listProviderUsage: async () => {
        throw new Error("usage service down");
      },
      logger: pino({ level: "silent" }),
    });
    await session.handleDoctorRequest({ type: "daemon.doctor.request", requestId: "r1" });
    expect(emitted).toHaveLength(1);
    const parsed = DaemonDoctorResponseSchema.parse(emitted[0]);
    expect(parsed.payload.requestId).toBe("r1");
    expect(parsed.payload.daemonVersion).toBe("0.8.0");
    const ids = parsed.payload.findings.map((f) => f.id);
    expect(ids).toEqual(
      expect.arrayContaining(["plugin.status", "account.budget", "config.keys", "disk.free"]),
    );
    // A usage service that throws degrades that one check to a skip; nothing else is lost.
    expect(parsed.payload.findings.find((f) => f.id === "account.budget")?.status).toBe("skip");
    expect(parsed.payload.findings.find((f) => f.id === "plugin.status")?.status).toBe("fail");
  }, 60_000);
});
