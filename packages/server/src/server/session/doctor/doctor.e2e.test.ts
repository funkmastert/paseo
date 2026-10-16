import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { DaemonClient } from "../../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../../test-utils/paseo-daemon.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

test("a real daemon runs the doctor for itself over daemon.doctor.request, and changes nothing", async () => {
  const daemon = await createTestPaseoDaemon();
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "doctor-e2e-home-")));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  // The account dirs, skills and CLAUDE.md the doctor reads live under HOME; keep them hermetic.
  mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "# rules\n");
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.8.1",
  });
  const previousHome = process.env["HOME"];
  try {
    await client.connect();
    expect(client.supportsDaemonDoctor()).toBe(true);

    // A key the daemon's strict schema does not know: the case that has broken a daemon before.
    writeFileSync(
      path.join(daemon.paseoHome, "config.json"),
      JSON.stringify({ version: 1, agents: { refocus: { enabled: false, notAKey: true } } }),
    );

    process.env["HOME"] = home;
    const report = await client.runDaemonDoctor({ timeout: 60_000 });
    process.env["HOME"] = previousHome;

    expect(report.findings.length).toBeGreaterThan(3);
    const byId = (id: string) => report.findings.filter((f) => f.id === id);
    const config = byId("config.keys")[0];
    expect(config?.status).toBe("fail");
    expect(config?.detail).toContain("unknown key agents.refocus.notAKey");
    // The daemon answered for itself, so it does not warn that it checked with the CLI's schema.
    expect(byId("config.keys.scope")).toHaveLength(0);
    expect(byId("daemon.build")[0]?.status).not.toBe("fail");
    expect(byId("disk.free")).toHaveLength(1);
    expect(report.daemonVersion).toBeTruthy();
  } finally {
    process.env["HOME"] = previousHome;
    await client.close();
    await daemon.close();
  }
}, 60_000);
