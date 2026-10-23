import { describe, expect, test, vi } from "vitest";
import type { JevWireRequest } from "./contract.js";
import { createHttpJevTransport } from "./transport.js";

function fakeResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const lowered = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    status,
    headers: { get: (name: string) => lowered[name.toLowerCase()] ?? null },
    json: async () => {
      if (body === undefined) throw new Error("not json");
      return body;
    },
  } as unknown as Response;
}

const REQUEST: JevWireRequest = { model: "jev-latest", state: "hello", questions: {} };

describe("createHttpJevTransport", () => {
  test("POSTs with the expected headers, body, redirect policy and signal", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, { ok: true }));
    const transport = createHttpJevTransport({
      provider: "openrouter",
      endpointUrl: "https://openrouter.ai/api/alpha/decisions",
      getKey: () => "secret-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const controller = new AbortController();

    await transport.send(REQUEST, { signal: controller.signal });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      body: JSON.stringify(REQUEST),
      signal: controller.signal,
    });
    expect((init as RequestInit).headers).toEqual({
      Authorization: "Bearer secret-key",
      "Content-Type": "application/json",
    });
  });

  test("returns the response for a successful status without throwing", async () => {
    const transport = createHttpJevTransport({
      provider: "typesafe",
      endpointUrl: "https://api.typesafe.ai/v1/systemone",
      getKey: () => "key",
      fetchImpl: (async () =>
        fakeResponse(200, { model: "jev-latest" })) as unknown as typeof fetch,
    });
    const result = await transport.send(REQUEST, { signal: new AbortController().signal });
    expect(result).toEqual({ status: 200, retryAfterMs: null, body: { model: "jev-latest" } });
  });

  test.each([404, 429, 500, 529])(
    "returns the response for HTTP %d without throwing",
    async (status) => {
      const transport = createHttpJevTransport({
        provider: "openrouter",
        endpointUrl: "https://openrouter.ai/api/alpha/decisions",
        getKey: () => "key",
        fetchImpl: (async () => fakeResponse(status, { error: "nope" })) as unknown as typeof fetch,
      });
      const result = await transport.send(REQUEST, { signal: new AbortController().signal });
      expect(result.status).toBe(status);
      expect(result.body).toEqual({ error: "nope" });
    },
  );

  test("returns null body when the response is not JSON", async () => {
    const transport = createHttpJevTransport({
      provider: "openrouter",
      endpointUrl: "https://openrouter.ai/api/alpha/decisions",
      getKey: () => "key",
      fetchImpl: (async () => fakeResponse(200, undefined)) as unknown as typeof fetch,
    });
    const result = await transport.send(REQUEST, { signal: new AbortController().signal });
    expect(result.body).toBeNull();
  });

  test("parses retryAfterMs from a seconds header", async () => {
    const transport = createHttpJevTransport({
      provider: "openrouter",
      endpointUrl: "https://openrouter.ai/api/alpha/decisions",
      getKey: () => "key",
      fetchImpl: (async () =>
        fakeResponse(429, {}, { "retry-after": "2" })) as unknown as typeof fetch,
    });
    const result = await transport.send(REQUEST, { signal: new AbortController().signal });
    expect(result.retryAfterMs).toBe(2000);
  });

  test("parses retryAfterMs from an HTTP-date header", async () => {
    const future = new Date(Date.now() + 5000);
    const transport = createHttpJevTransport({
      provider: "openrouter",
      endpointUrl: "https://openrouter.ai/api/alpha/decisions",
      getKey: () => "key",
      fetchImpl: (async () =>
        fakeResponse(429, {}, { "retry-after": future.toUTCString() })) as unknown as typeof fetch,
    });
    const result = await transport.send(REQUEST, { signal: new AbortController().signal });
    expect(result.retryAfterMs).not.toBeNull();
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(5000);
  });

  test("retryAfterMs is null when the header is missing or unparseable", async () => {
    const transportMissing = createHttpJevTransport({
      provider: "openrouter",
      endpointUrl: "https://openrouter.ai/api/alpha/decisions",
      getKey: () => "key",
      fetchImpl: (async () => fakeResponse(200, {})) as unknown as typeof fetch,
    });
    expect(
      (await transportMissing.send(REQUEST, { signal: new AbortController().signal })).retryAfterMs,
    ).toBeNull();

    const transportBad = createHttpJevTransport({
      provider: "openrouter",
      endpointUrl: "https://openrouter.ai/api/alpha/decisions",
      getKey: () => "key",
      fetchImpl: (async () =>
        fakeResponse(429, {}, { "retry-after": "not-a-value" })) as unknown as typeof fetch,
    });
    expect(
      (await transportBad.send(REQUEST, { signal: new AbortController().signal })).retryAfterMs,
    ).toBeNull();
  });

  test("throws jev: no key without calling fetch when getKey returns null", async () => {
    const fetchImpl = vi.fn();
    const transport = createHttpJevTransport({
      provider: "openrouter",
      endpointUrl: "https://openrouter.ai/api/alpha/decisions",
      getKey: () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(transport.send(REQUEST, { signal: new AbortController().signal })).rejects.toThrow(
      "jev: no key",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("never leaks the key when the underlying fetch throws", async () => {
    const key = "sk-super-secret-leak-marker";
    const transport = createHttpJevTransport({
      provider: "openrouter",
      endpointUrl: "https://openrouter.ai/api/alpha/decisions?token=" + key,
      getKey: () => key,
      fetchImpl: (async () => {
        throw new Error(`network failure while sending Bearer ${key} to the endpoint`);
      }) as unknown as typeof fetch,
    });
    let thrown: unknown;
    try {
      await transport.send(REQUEST, { signal: new AbortController().signal });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(key);
  });

  test("throws a generic error when the signal is aborted", async () => {
    const controller = new AbortController();
    const transport = createHttpJevTransport({
      provider: "openrouter",
      endpointUrl: "https://openrouter.ai/api/alpha/decisions",
      getKey: () => "key",
      fetchImpl: (async () => {
        throw new DOMException("This operation was aborted", "AbortError");
      }) as unknown as typeof fetch,
    });
    controller.abort();
    await expect(transport.send(REQUEST, { signal: controller.signal })).rejects.toThrow(
      "jev: request failed",
    );
  });
});
