import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { CoordinationRuntime, CoordinationUnavailableError } from "./runtime.js";

let paseoHome: string;
let runtime: CoordinationRuntime | null = null;

beforeEach(async () => {
  paseoHome = await fs.mkdtemp(path.join(os.tmpdir(), "coordination-runtime-"));
});

afterEach(async () => {
  runtime?.stop();
  runtime = null;
  await fs.rm(paseoHome, { recursive: true, force: true });
});

function build(config: { enabled?: boolean }): CoordinationRuntime {
  runtime = new CoordinationRuntime({
    paseoHome,
    config,
    logger: createTestLogger(),
    deliver: async () => undefined,
    turns: { onTurnEnded: () => () => undefined, getFinalMessage: async () => null },
    serverId: "server-test",
  });
  return runtime;
}

describe("coordination runtime", () => {
  it("is off by default: not advertised, and every request is refused as disabled", async () => {
    const off = build({});
    await off.start();
    expect(off.status).toBe("disabled");
    expect(off.advertised).toBe(false);
    await expect(off.require()).rejects.toBeInstanceOf(CoordinationUnavailableError);
  });

  it("opens the store under PASEO_HOME and serves the queue", async () => {
    const on = build({ enabled: true });
    expect(on.advertised).toBe(true);
    await on.start();
    expect(on.status).toBe("open");
    const { queue } = await on.require();
    await queue.create({ id: "wi-1", title: "Review", owner: "human" });
    await expect(fs.stat(path.join(paseoHome, "coordination", "queue"))).resolves.toBeTruthy();
  });

  it("lets a request made before start wait for the open", async () => {
    const on = build({ enabled: true });
    const pending = on.require();
    await on.start();
    await expect(pending).resolves.toHaveProperty("queue");
  });

  it("runs without coordination when the store cannot open, and never throws from start", async () => {
    // A file where the queue directory belongs makes the open fail.
    await fs.mkdir(path.join(paseoHome, "coordination"), { recursive: true });
    await fs.writeFile(path.join(paseoHome, "coordination", "queue"), "not a directory");
    const broken = build({ enabled: true });
    await expect(broken.start()).resolves.toBeUndefined();
    expect(broken.status).toBe("failed");
    expect(broken.advertised).toBe(false);
    await expect(broken.require()).rejects.toThrow(/failed to open/);
  });
});
