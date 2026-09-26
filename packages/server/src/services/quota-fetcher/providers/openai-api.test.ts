import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  nextMonthStartUtc,
  OpenAiApiUsageProvider,
  parseEnvFileValue,
  type OpenAiApiUsageConfig,
} from "./openai-api.js";

// Fixture keys only. Never a real credential.
const FIXTURE_KEY = "sk-proj-FIXTURE-not-a-real-key";
const FIXTURE_ADMIN_KEY = "sk-admin-FIXTURE-not-a-real-key";

const NOW = Date.parse("2026-09-25T19:30:00Z");
const MONTH_START_SEC = Date.parse("2026-09-01T00:00:00Z") / 1000;

function bucket(day: number, values: number[], currency = "usd") {
  const start = MONTH_START_SEC + (day - 1) * 86_400;
  return {
    object: "bucket",
    start_time: start,
    end_time: start + 86_400,
    results: values.map((value) => ({
      object: "organization.costs.result",
      amount: { value, currency },
      line_item: null,
      project_id: null,
    })),
  };
}

function page(buckets: unknown[], next: string | null = null) {
  return { object: "page", data: buckets, has_more: next !== null, next_page: next };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("parseEnvFileValue", () => {
  it("reads a double-quoted export line", () => {
    expect(parseEnvFileValue(`export OPENAI_ADMIN_KEY="abc123"\n`, "OPENAI_ADMIN_KEY")).toBe(
      "abc123",
    );
  });

  it("reads single-quoted and bare values, with or without export", () => {
    expect(parseEnvFileValue("export A='one'\nB=two\n", "A")).toBe("one");
    expect(parseEnvFileValue("export A='one'\nB=two\n", "B")).toBe("two");
  });

  it("ignores comments, other names, and prefixed names", () => {
    const text = [
      "# export OPENAI_ADMIN_KEY=commented",
      "export OPENAI_ADMIN_KEY_OLD=old",
      "export OPENAI_API_KEY=other",
    ].join("\n");
    expect(parseEnvFileValue(text, "OPENAI_ADMIN_KEY")).toBeNull();
  });

  it("drops a trailing comment on an unquoted value and keeps # inside quotes", () => {
    expect(parseEnvFileValue("K=value # note", "K")).toBe("value");
    expect(parseEnvFileValue(`K="va#lue"`, "K")).toBe("va#lue");
  });

  it("takes the last assignment, like a shell would", () => {
    expect(parseEnvFileValue("K=first\nK=second\n", "K")).toBe("second");
  });

  it("returns null for an empty value and tolerates CRLF", () => {
    expect(parseEnvFileValue(`K=""\n`, "K")).toBeNull();
    expect(parseEnvFileValue("K=win\r\n", "K")).toBe("win");
  });
});

describe("nextMonthStartUtc", () => {
  it("is the first of the next month, UTC", () => {
    expect(nextMonthStartUtc(new Date("2026-09-25T19:30:00Z"))).toBe("2026-10-01T00:00:00.000Z");
  });

  it("rolls the year in December", () => {
    expect(nextMonthStartUtc(new Date("2026-12-31T23:59:59Z"))).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("OpenAiApiUsageProvider", () => {
  let dir: string;
  let envFile: string;
  let config: OpenAiApiUsageConfig | undefined;
  let env: NodeJS.ProcessEnv;
  let fetchMock: ReturnType<typeof vi.fn>;
  let nowMs: number;
  const logger = pino({ level: "silent" });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openai-api-usage-"));
    envFile = join(dir, "env");
    config = { enabled: true, envFile };
    env = {};
    nowMs = NOW;
    fetchMock = vi.fn();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeProvider() {
    return new OpenAiApiUsageProvider({
      logger,
      fetch: fetchMock as unknown as typeof fetch,
      readConfig: () => config,
      env,
      now: () => nowMs,
    });
  }

  function writeKey(value = FIXTURE_KEY, name = "OPENAI_API_KEY") {
    writeFileSync(envFile, `export UNRELATED="x"\nexport ${name}="${value}"\n`);
  }

  it("reports nothing when disabled or unconfigured", async () => {
    config = undefined;
    expect(await makeProvider().fetchUsage()).toBeNull();
    config = { enabled: false, envFile };
    writeKey();
    expect(await makeProvider().fetchUsage()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks for the key when enabled without one, without calling the API", async () => {
    const usage = await makeProvider().fetchUsage();
    expect(usage).toMatchObject({
      providerId: "openai-api",
      displayName: "OpenAI API (image gen)",
      status: "error",
      windows: [],
    });
    expect(usage?.error).toBe(`Add OPENAI_API_KEY to ${envFile}`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sums month-to-date costs from the env-file key and asks for the month's daily buckets", async () => {
    writeKey();
    fetchMock.mockResolvedValueOnce(jsonResponse(page([bucket(1, [1.25, 0.5]), bucket(2, [3])])));

    const usage = await makeProvider().fetchUsage();

    expect(usage).toMatchObject({
      providerId: "openai-api",
      displayName: "OpenAI API (image gen)",
      status: "available",
      error: null,
      windows: [],
      balances: [{ id: "spend", label: "Spent this month", used: 4.75, unit: "usd" }],
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://api.openai.com/v1/organization/costs");
    expect(parsed.searchParams.get("start_time")).toBe(String(MONTH_START_SEC));
    expect(parsed.searchParams.get("bucket_width")).toBe("1d");
    expect(parsed.searchParams.get("limit")).toBe("31");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${FIXTURE_KEY}`);
  });

  it("tries the admin key name first when it is present, and falls back to keyEnv", async () => {
    writeFileSync(
      envFile,
      `export OPENAI_API_KEY="${FIXTURE_KEY}"\nexport OPENAI_ADMIN_KEY="${FIXTURE_ADMIN_KEY}"\n`,
    );
    fetchMock.mockImplementation(async () => jsonResponse(page([bucket(1, [1])])));

    await makeProvider().fetchUsage();
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${FIXTURE_ADMIN_KEY}`,
    });

    writeKey();
    await makeProvider().fetchUsage();
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${FIXTURE_KEY}`,
    });
  });

  it("prefers the environment variable over the env file, and honours keyEnv", async () => {
    writeKey("sk-admin-FROM-FILE");
    env = { CUSTOM_ADMIN: "sk-admin-FROM-ENV" };
    config = { enabled: true, envFile, keyEnv: "CUSTOM_ADMIN", label: "Images" };
    fetchMock.mockResolvedValueOnce(jsonResponse(page([bucket(1, [1])])));

    const usage = await makeProvider().fetchUsage();

    expect(usage?.displayName).toBe("Images");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-admin-FROM-ENV");
  });

  it("follows next_page until the last page", async () => {
    writeKey();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(page([bucket(1, [1])], "cursor_2")))
      .mockResolvedValueOnce(jsonResponse(page([bucket(2, [2])], "cursor_3")))
      .mockResolvedValueOnce(jsonResponse(page([bucket(3, [4])])));

    const usage = await makeProvider().fetchUsage();

    expect(usage?.balances?.[0]?.used).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new URL(fetchMock.mock.calls[1][0] as string).searchParams.get("page")).toBe("cursor_2");
    expect(new URL(fetchMock.mock.calls[2][0] as string).searchParams.get("page")).toBe("cursor_3");
  });

  it("adds a month window against the budget, resetting at the next month start (UTC)", async () => {
    writeKey();
    config = { enabled: true, envFile, monthlyBudgetUsd: 50 };
    fetchMock.mockResolvedValueOnce(jsonResponse(page([bucket(1, [10, 2.5])])));

    const usage = await makeProvider().fetchUsage();

    expect(usage?.windows).toEqual([
      expect.objectContaining({
        id: "month",
        label: "Month",
        usedPct: 25,
        remainingPct: 75,
        resetsAt: "2026-10-01T00:00:00.000Z",
        tone: "ok",
      }),
    ]);
    expect(usage?.balances?.[0]).toMatchObject({ used: 12.5, limit: 50 });
  });

  it("flags a budget that is nearly or fully spent", async () => {
    writeKey();
    config = { enabled: true, envFile, monthlyBudgetUsd: 10 };
    fetchMock.mockResolvedValueOnce(jsonResponse(page([bucket(1, [12])])));

    const usage = await makeProvider().fetchUsage();

    expect(usage?.windows[0]).toMatchObject({ usedPct: 120, remainingPct: 0, tone: "danger" });
  });

  it("counts an empty month as zero spend", async () => {
    writeKey();
    fetchMock.mockResolvedValueOnce(jsonResponse(page([])));
    const usage = await makeProvider().fetchUsage();
    expect(usage?.status).toBe("available");
    expect(usage?.balances?.[0]?.used).toBe(0);
  });

  it("ignores non-usd results", async () => {
    writeKey();
    fetchMock.mockResolvedValueOnce(jsonResponse(page([bucket(1, [2]), bucket(2, [999], "eur")])));
    const usage = await makeProvider().fetchUsage();
    expect(usage?.balances?.[0]?.used).toBe(2);
  });

  it("caches the spend for refreshMinutes, then refetches", async () => {
    writeKey();
    config = { enabled: true, envFile, refreshMinutes: 30 };
    fetchMock.mockImplementation(async () => jsonResponse(page([bucket(1, [1])])));
    const provider = makeProvider();

    await provider.fetchUsage();
    nowMs += 29 * 60_000;
    await provider.fetchUsage();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    nowMs += 2 * 60_000;
    await provider.fetchUsage();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("applies a changed budget to cached spend without refetching", async () => {
    writeKey();
    config = { enabled: true, envFile, monthlyBudgetUsd: 100 };
    fetchMock.mockImplementation(async () => jsonResponse(page([bucket(1, [10])])));
    const provider = makeProvider();

    expect((await provider.fetchUsage())?.windows[0]?.usedPct).toBe(10);
    config = { enabled: true, envFile, monthlyBudgetUsd: 20 };
    expect((await provider.fetchUsage())?.windows[0]?.usedPct).toBe(50);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refetches when the month rolls over", async () => {
    writeKey();
    fetchMock.mockImplementation(async () => jsonResponse(page([bucket(1, [1])])));
    const provider = makeProvider();

    await provider.fetchUsage();
    nowMs = Date.parse("2026-10-01T00:05:00Z");
    await provider.fetchUsage();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(fetchMock.mock.calls[1][0] as string).searchParams.get("start_time")).toBe(
      String(Date.parse("2026-10-01T00:00:00Z") / 1000),
    );
  });

  it("tells Tyler to grant Usage: Read on a 403 that names the api.usage.read scope", async () => {
    writeKey();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            message: `You have insufficient permissions for this operation. Missing scopes: api.usage.read. key ${FIXTURE_KEY}`,
          },
        },
        403,
      ),
    );

    const usage = await makeProvider().fetchUsage();

    expect(usage?.status).toBe("error");
    expect(usage?.error).toBe(
      "Give this OpenAI key Usage: Read (platform.openai.com → API keys → Permissions)",
    );
  });

  it("keeps a separate message for a 401 (invalid or revoked key)", async () => {
    writeKey();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: `Incorrect API key provided: ${FIXTURE_KEY}` } }, 401),
    );

    const usage = await makeProvider().fetchUsage();

    expect(usage?.status).toBe("error");
    expect(usage?.error).toMatch(/invalid or revoked/i);
    expect(usage?.error).not.toContain("Usage: Read");
    expect(usage?.error).not.toContain(FIXTURE_KEY);
  });

  it("reports any other 403 without the scope hint or the response body", async () => {
    writeKey();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: `role cannot read costs ${FIXTURE_KEY}` } }, 403),
    );

    const usage = await makeProvider().fetchUsage();

    expect(usage?.status).toBe("error");
    expect(usage?.error).toContain("403");
    expect(usage?.error).not.toContain("Usage: Read");
    expect(usage?.error).not.toContain(FIXTURE_KEY);
  });

  it("reports other HTTP failures and network failures without the key", async () => {
    writeKey();
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));
    const failed = await makeProvider().fetchUsage();
    expect(failed).toMatchObject({ status: "error" });
    expect(failed?.error).toContain("500");

    fetchMock.mockRejectedValueOnce(new Error(`connect failed with ${FIXTURE_KEY}`));
    const unreachable = await makeProvider().fetchUsage();
    expect(unreachable?.status).toBe("error");
    expect(unreachable?.error).not.toContain(FIXTURE_KEY);
  });

  it("never logs the key", async () => {
    writeKey();
    const lines: string[] = [];
    const capture = pino({ level: "trace" }, { write: (line: string) => void lines.push(line) });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: FIXTURE_KEY } }, 403));
    const provider = new OpenAiApiUsageProvider({
      logger: capture,
      fetch: fetchMock as unknown as typeof fetch,
      readConfig: () => config,
      env,
      now: () => nowMs,
    });

    await provider.fetchUsage();

    expect(lines.join("\n")).not.toContain("FIXTURE");
  });
});
