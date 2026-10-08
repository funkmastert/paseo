import type { Logger } from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { AgentPromptContentBlock } from "../agent/agent-sdk-types.js";
import { type CapturedLink, captureLinksFromPrompt, setLinkCaptureSink } from "./link-capture.js";

function createRecordingLogger(): Pick<Logger, "warn"> {
  return { warn: vi.fn() as unknown as Logger["warn"] };
}

function recordingSink(): {
  sink: (agentId: string, link: CapturedLink) => void;
  calls: Array<{ agentId: string; link: CapturedLink }>;
} {
  const calls: Array<{ agentId: string; link: CapturedLink }> = [];
  return {
    calls,
    sink: (agentId, link) => {
      calls.push({ agentId, link });
    },
  };
}

/** Lets the fire-and-forget sink dispatch (a microtask) run before assertions. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  setLinkCaptureSink(null);
});

describe("captureLinksFromPrompt", () => {
  test("with no sink installed, does nothing", async () => {
    const logger = createRecordingLogger();
    captureLinksFromPrompt("agent-1", "see https://www.figma.com/design/fake123/Checkout", logger);
    await flush();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("extracts a figma link without trailing punctuation", async () => {
    const { sink, calls } = recordingSink();
    setLinkCaptureSink(sink);
    const logger = createRecordingLogger();

    captureLinksFromPrompt(
      "agent-1",
      "See https://www.figma.com/design/fake123/Checkout?node-id=1-2.",
      logger,
    );
    await flush();

    expect(calls).toEqual([
      {
        agentId: "agent-1",
        link: {
          url: "https://www.figma.com/design/fake123/Checkout?node-id=1-2",
          kind: "figma",
          host: "www.figma.com",
        },
      },
    ]);
  });

  test("trims a URL in parentheses or followed by '),'", async () => {
    const { sink, calls } = recordingSink();
    setLinkCaptureSink(sink);
    const logger = createRecordingLogger();

    captureLinksFromPrompt(
      "agent-1",
      "(see https://linear.app/team/issue/ABC-123), then start",
      logger,
    );
    await flush();

    expect(calls.map((c) => c.link.url)).toEqual(["https://linear.app/team/issue/ABC-123"]);
    expect(calls[0]?.link.kind).toBe("ticket");
  });

  test("skips loopback, private-network and file: URLs", async () => {
    const { sink, calls } = recordingSink();
    setLinkCaptureSink(sink);
    const logger = createRecordingLogger();

    captureLinksFromPrompt(
      "agent-1",
      "http://localhost:8081 http://127.0.0.1/x http://192.168.1.4 file:///tmp/a",
      logger,
    );
    await flush();

    expect(calls).toEqual([]);
  });

  test("classifies a forge pull-request path as pr and an issue path as ticket", async () => {
    const { sink, calls } = recordingSink();
    setLinkCaptureSink(sink);
    const logger = createRecordingLogger();

    captureLinksFromPrompt(
      "agent-1",
      "https://git.example.com/org/repo/pull/42 and https://git.example.com/org/repo/issues/7",
      logger,
    );
    await flush();

    expect(calls.map((c) => c.link.kind)).toEqual(["pr", "ticket"]);
  });

  test("ignores image and attachment parts, reading only text", async () => {
    const { sink, calls } = recordingSink();
    setLinkCaptureSink(sink);
    const logger = createRecordingLogger();

    const prompt: AgentPromptContentBlock[] = [
      { type: "text", text: "https://www.figma.com/design/fake123/Checkout" },
      { type: "image", data: "https://evil.example.com/should-not-be-read", mimeType: "image/png" },
      {
        type: "uploaded_file",
        id: "f1",
        fileName: "https://also-evil.example.com/ignored",
        mimeType: "text/plain",
        size: 0,
        path: "/tmp/a.txt",
      },
    ];

    captureLinksFromPrompt("agent-1", prompt, logger);
    await flush();

    expect(calls.map((c) => c.link.url)).toEqual(["https://www.figma.com/design/fake123/Checkout"]);
  });

  test("covers AE4: a fake token beside a link yields only the scrubbed link", async () => {
    const { sink, calls } = recordingSink();
    setLinkCaptureSink(sink);
    const logger = createRecordingLogger();

    captureLinksFromPrompt(
      "agent-1",
      "key sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa next to https://linear.app/team/issue/ABC-9",
      logger,
    );
    await flush();

    expect(calls.map((c) => c.link.url)).toEqual(["https://linear.app/team/issue/ABC-9"]);
  });

  test("a sink that throws is logged with kind and host only, not the raw URL, and other links still go out", async () => {
    const logger = createRecordingLogger();
    const delivered: string[] = [];
    setLinkCaptureSink((_agentId, link) => {
      if (link.host === "www.figma.com") throw new Error("disk full");
      delivered.push(link.url);
    });

    captureLinksFromPrompt(
      "agent-1",
      "https://www.figma.com/design/fake123/Secret and https://linear.app/team/issue/ABC-1",
      logger,
    );
    await flush();

    expect(delivered).toEqual(["https://linear.app/team/issue/ABC-1"]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [fields, message] = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(fields).toMatchObject({ kind: "figma", host: "www.figma.com" });
    expect(JSON.stringify(fields)).not.toContain("figma.com/design/fake123/Secret");
    expect(message).not.toContain("figma.com/design/fake123/Secret");
  });

  test("640 KB of hostile input with no whitespace finishes in under 100 ms", async () => {
    const { sink } = recordingSink();
    setLinkCaptureSink(sink);
    const logger = createRecordingLogger();
    const hostile = "http://".repeat(91_500); // ~640 KB, no whitespace

    const started = performance.now();
    captureLinksFromPrompt("agent-1", hostile, logger);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
