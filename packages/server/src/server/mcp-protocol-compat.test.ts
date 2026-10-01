import type { IncomingMessage } from "node:http";
import { describe, expect, test } from "vitest";
import {
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
} from "@modelcontextprotocol/sdk/types.js";

import { normalizeMcpProtocolVersionHeader } from "./mcp-protocol-compat.js";

function fakeRequest(headerValue: string | string[] | undefined): IncomingMessage {
  const headers: Record<string, string | string[] | undefined> = {};
  const rawHeaders: string[] = [];
  if (headerValue !== undefined) {
    headers["mcp-protocol-version"] = headerValue;
    for (const value of Array.isArray(headerValue) ? headerValue : [headerValue]) {
      rawHeaders.push("Mcp-Protocol-Version", value);
    }
  }
  return { headers, rawHeaders } as unknown as IncomingMessage;
}

describe("normalizeMcpProtocolVersionHeader", () => {
  test("rewrites an unrecognized version to the SDK's latest supported version", () => {
    const req = fakeRequest("2026-07-28");

    normalizeMcpProtocolVersionHeader(req);

    expect(req.headers["mcp-protocol-version"]).toBe(LATEST_PROTOCOL_VERSION);
    expect(req.rawHeaders).toEqual(["Mcp-Protocol-Version", LATEST_PROTOCOL_VERSION]);
  });

  test("leaves a supported version untouched", () => {
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      const req = fakeRequest(version);

      normalizeMcpProtocolVersionHeader(req);

      expect(req.headers["mcp-protocol-version"]).toBe(version);
      expect(req.rawHeaders).toEqual(["Mcp-Protocol-Version", version]);
    }
  });

  test("leaves a missing header untouched", () => {
    const req = fakeRequest(undefined);

    normalizeMcpProtocolVersionHeader(req);

    expect(req.headers["mcp-protocol-version"]).toBeUndefined();
    expect(req.rawHeaders).toEqual([]);
  });

  test("normalizes a duplicated header's parsed and raw forms consistently", () => {
    const req = fakeRequest(["2026-07-28", "2025-11-25"]);

    normalizeMcpProtocolVersionHeader(req);

    expect(req.headers["mcp-protocol-version"]).toBe(LATEST_PROTOCOL_VERSION);
    expect(req.rawHeaders).toEqual([
      "Mcp-Protocol-Version",
      LATEST_PROTOCOL_VERSION,
      "Mcp-Protocol-Version",
      LATEST_PROTOCOL_VERSION,
    ]);
  });
});
