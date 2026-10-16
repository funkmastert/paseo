import type { JevTransport, JevTransportResponse, JevWireRequest } from "./contract.js";

const RETRY_AFTER_DATE_PREFIX_RE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i;

function parseRetryAfterMs(header: string | null): number | null {
  if (!header?.trim()) return null;
  const value = header.trim();
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const ms = Number(value) * 1000;
    return Number.isFinite(ms) ? ms : null;
  }
  // HTTP-date forms begin with a weekday name; Date.parse alone also accepts non-dates like "-1".
  if (!RETRY_AFTER_DATE_PREFIX_RE.test(value)) return null;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export function createHttpJevTransport(options: {
  provider: "openrouter" | "typesafe";
  endpointUrl: string;
  getKey: () => string | null;
  fetchImpl?: typeof fetch;
}): JevTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    provider: options.provider,
    async send(
      request: JevWireRequest,
      { signal }: { signal: AbortSignal },
    ): Promise<JevTransportResponse> {
      const key = options.getKey();
      if (key === null) throw new Error("jev: no key");

      let response: Response;
      try {
        response = await fetchImpl(options.endpointUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify(request),
          redirect: "error",
          signal,
        });
      } catch {
        // Never surface the underlying error: it can carry the key, the URL, or the body.
        throw new Error("jev: request failed");
      }

      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }

      return {
        status: response.status,
        retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
        body,
      };
    },
  };
}
