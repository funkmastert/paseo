import { describe, expect, it } from "vitest";
import { DaemonDoctorResponseSchema } from "./doctor/rpc-schemas.js";
import { SessionInboundMessageSchema, WSOutboundMessageSchema } from "./messages.js";

describe("daemon.doctor RPC", () => {
  it("parses the request with and without deep", () => {
    expect(
      SessionInboundMessageSchema.parse({ type: "daemon.doctor.request", requestId: "r" }),
    ).toEqual({
      type: "daemon.doctor.request",
      requestId: "r",
    });
    expect(
      SessionInboundMessageSchema.parse({
        type: "daemon.doctor.request",
        requestId: "r",
        deep: true,
      }),
    ).toMatchObject({ deep: true });
  });

  it("parses a response over the outbound envelope, and rejects a finding with no status", () => {
    const message = {
      type: "daemon.doctor.response",
      payload: {
        requestId: "r",
        generatedAt: "2026-09-23T00:00:00.000Z",
        findings: [
          { id: "disk.free", category: "disk", status: "warn", title: "t", fix: "rm -rf x" },
        ],
      },
    };
    expect(DaemonDoctorResponseSchema.parse(message).payload.findings).toHaveLength(1);
    expect(WSOutboundMessageSchema.safeParse({ type: "session", message }).success).toBe(true);
    const bad = structuredClone(message);
    delete (bad.payload.findings[0] as Record<string, unknown>)["status"];
    expect(DaemonDoctorResponseSchema.safeParse(bad).success).toBe(false);
  });

  it("tolerates a newer daemon adding fields to a finding", () => {
    const parsed = DaemonDoctorResponseSchema.parse({
      type: "daemon.doctor.response",
      payload: {
        requestId: "r",
        generatedAt: "x",
        findings: [{ id: "a", category: "b", status: "ok", title: "c", future: 1 }],
      },
    });
    expect(parsed.payload.findings[0]?.id).toBe("a");
  });
});
