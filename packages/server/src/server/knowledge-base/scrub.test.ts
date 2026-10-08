import { describe, expect, test } from "vitest";

import { scrubText, scrubUrl } from "./scrub.js";

describe("scrubUrl", () => {
  test("covers AE4: a token-shaped query param is dropped and an ordinary param is kept", () => {
    expect(scrubUrl("https://tracker.example/issue?token=fake-abc123def456&id=7")).toBe(
      "https://tracker.example/issue?id=7",
    );
  });

  test("userinfo is stripped", () => {
    expect(scrubUrl("https://user:pw@host.example/x")).toBe("https://host.example/x");
  });

  test("a URL still token-shaped after scrubbing (a token in the path) is dropped entirely", () => {
    expect(scrubUrl("https://github.example/repo?x=1#ghp_abcdefghijklmnopqrstuvwxyz012345")).toBe(
      null,
    );
  });

  test("a 640 KB URL with no spaces finishes in under 100 ms", () => {
    const hostile = `https://example.com/${"a".repeat(640_000)}`;
    const started = performance.now();
    scrubUrl(hostile);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("scrubText", () => {
  test("replaces a fake sk-ant- key and a fake JWT with [redacted] and reports 2", () => {
    // The shared token pattern matches a JWT's header.payload (two eyJ... segments); it does not
    // require or capture a third signature segment, so this fixture has only two.
    const fakeJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0";
    const text = `key sk-ant-${"a".repeat(20)} and jwt ${fakeJwt} end`;
    const { text: scrubbed, removed } = scrubText(text);
    expect(removed).toBe(2);
    expect(scrubbed).toBe("key [redacted] and jwt [redacted] end");
  });

  test("text with no secret-shaped span is unchanged and reports 0", () => {
    const { text, removed } = scrubText("nothing secret here, just plain decision text");
    expect(removed).toBe(0);
    expect(text).toBe("nothing secret here, just plain decision text");
  });
});
