import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createProviderEnv } from "../agent/provider-launch-config.js";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import { createFakeJevTransport, type FakeJevTransport } from "./fake.js";

// A real daemon on a temp PASEO_HOME with the fake JEV transport: bootstrap's key capture, the
// four RPCs over the WebSocket, the session handlers and the service all run for real. No
// network: the fake is the only transport, and PASEO_JEV_API_KEY is a made-up value.

const FAKE_KEY = "fake-e2e-jev-key-00000000000000000000";
const MARKER = "jev-e2e-env-marker-present";

let ctx: DaemonTestContext;
let transport: FakeJevTransport;
let workdir: string;
const saved = { key: process.env.PASEO_JEV_API_KEY, marker: process.env.JEV_E2E_MARKER };

beforeAll(async () => {
  workdir = mkdtempSync(path.join(tmpdir(), "jev-e2e-"));
  mkdirSync(path.join(workdir, "safe"), { recursive: true });
  process.env.PASEO_JEV_API_KEY = FAKE_KEY;
  process.env.JEV_E2E_MARKER = MARKER;
  transport = createFakeJevTransport({
    answers: { task_class: { type: "choice", choice: "mechanical", confidence: 0.9 } },
  });
  ctx = await createDaemonTestContext({ jevOverrides: { transport } });
}, 60_000);

afterAll(async () => {
  await ctx?.cleanup();
  rmSync(workdir, { recursive: true, force: true });
  if (saved.key === undefined) delete process.env.PASEO_JEV_API_KEY;
  else process.env.PASEO_JEV_API_KEY = saved.key;
  if (saved.marker === undefined) delete process.env.JEV_E2E_MARKER;
  else process.env.JEV_E2E_MARKER = saved.marker;
});

describe("the key never reaches a child", () => {
  test("the daemon removed it from its own environment at startup", () => {
    expect(process.env.PASEO_JEV_API_KEY).toBeUndefined();
    expect(process.env.JEV_E2E_MARKER).toBe(MARKER);
  });

  test("an agent's environment does not carry it", () => {
    const env = createProviderEnv();
    expect(env.PASEO_JEV_API_KEY).toBeUndefined();
    expect(env.JEV_E2E_MARKER).toBe(MARKER);
    expect(JSON.stringify(env)).not.toContain(FAKE_KEY);
  });

  // /bin/sh does not exist on win32.
  test.skipIf(process.platform === "win32")(
    "a terminal's environment does not carry it",
    async () => {
      const workspace = await ctx.client.createWorkspace({
        source: { kind: "directory", path: workdir },
        title: "jev-e2e",
      });
      expect(workspace.error ?? null).toBeNull();
      const created = await ctx.client.createTerminal(workdir, "env-check", undefined, {
        workspaceId: workspace.workspace!.id,
        command: "/bin/sh",
        args: ["-c", "env; echo JEV_E2E_DONE; sleep 5"],
      });
      expect(created.error).toBeNull();
      const terminalId = created.terminal?.id;
      expect(terminalId).toBeTruthy();
      let text = "";
      for (let i = 0; i < 50 && !text.includes("JEV_E2E_DONE"); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const captured = await ctx.client.captureTerminal(terminalId!, { stripAnsi: true });
        text = captured.lines.join("\n");
      }
      expect(text).toContain("JEV_E2E_DONE");
      expect(text).toContain(MARKER);
      expect(text).not.toContain(FAKE_KEY);
      expect(text).not.toContain("PASEO_JEV_API_KEY");
    },
  );
});

describe("the four RPCs over the wire", () => {
  test("jev.status reports the fake backend and never the key", async () => {
    const { status } = await ctx.client.jevStatus({ timeout: 5_000 });
    expect(status.available).toBe(true);
    expect(status.keyPresent).toBe(true);
    expect(status.provider).toBe("fake");
    expect(status.features.spawnHint?.shadow).toBe(true);
    expect(JSON.stringify(status)).not.toContain(FAKE_KEY);
  });

  test("jev.scope.check answers ok for a safe cwd and excluded under a D7 root", async () => {
    await expect(
      ctx.client.jevScopeCheck({ cwd: path.join(workdir, "safe") }, { timeout: 5_000 }),
    ).resolves.toMatchObject({ scope: "ok" });
    await expect(
      ctx.client.jevScopeCheck({ cwd: "~/mobile-worktrees/app" }, { timeout: 5_000 }),
    ).resolves.toMatchObject({ scope: "excluded" });
  });

  test("jev.decide answers a spawn hint in shadow and refuses other features", async () => {
    const questions = {
      task_class: {
        type: "choice" as const,
        instructions: "Which class of work does `prompt` hand to the new agent?",
        criteria: { mechanical: "Rote", standard: "Ordinary", hard: "Open-ended", other: "None" },
      },
    };
    const hint = await ctx.client.jevDecide(
      {
        feature: "spawnHint",
        callSite: "e2e.spawn-hint",
        state: { title: "bump", prompt: "bump the version" },
        questions,
        scope: { cwd: path.join(workdir, "safe") },
      },
      { timeout: 5_000 },
    );
    expect(hint.outcome).toBe("shadow");
    expect(hint.answers?.task_class).toMatchObject({ type: "choice", choice: "mechanical" });

    const unscoped = await ctx.client.jevDecide(
      { feature: "spawnHint", callSite: "e2e.unscoped", state: "x", questions },
      { timeout: 5_000 },
    );
    expect(unscoped).toMatchObject({ outcome: "unavailable", reason: "excluded" });

    const tools = await ctx.client.jevDecide(
      {
        feature: "agentTools",
        callSite: "e2e.phone",
        state: "x",
        questions,
        scope: { cwd: path.join(workdir, "safe") },
      },
      { timeout: 5_000 },
    );
    expect(tools).toMatchObject({ outcome: "failed", reason: "invalid-request" });
    expect(transport.calls).toHaveLength(1);
  });

  test("jev.decisions.list answers an empty list for an agent with no decisions", async () => {
    const result = await ctx.client.listJevDecisions("no-such-agent", { timeout: 5_000 });
    expect(result.decisions).toEqual([]);
  });
});
