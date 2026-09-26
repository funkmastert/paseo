import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DoctorFinding } from "@getpaseo/protocol/doctor/rpc-schemas";
import { accountBudgetCheck, accountConfigCheck, accountLoginCheck } from "./accounts.js";
import { buildCheck } from "./build.js";
import { configCheck } from "./config.js";
import { diskCheck } from "./disk.js";
import { mcpGatewayCheck } from "./mcp-gateway.js";
import { pluginCheck } from "./plugins.js";
import { DOCTOR_CHECKS, runDoctorChecks } from "./runner.js";
import { skillsCheck } from "./skills.js";
import {
  fakeProbes,
  link,
  makeAccountDir,
  makeContext,
  makeFixture,
  poolConfig,
  snapshotTree,
  writeConfig,
} from "./test-support.js";

const GIB = 1024 ** 3;

function byStatus(findings: DoctorFinding[], status: DoctorFinding["status"]) {
  return findings.filter((f) => f.status === status);
}

describe("account CLAUDE.md and projects/ links", () => {
  it("fails a slot with no CLAUDE.md and prints the exact ln command", async () => {
    const fx = makeFixture();
    writeConfig(fx, poolConfig(fx));
    makeAccountDir(path.join(fx.home, ".claude-leader"));
    const findings = await accountConfigCheck.run(makeContext(fx), Date.now() + 5000);
    const missing = findings.find(
      (f) => f.id === "account.claude-md" && f.title.includes(".claude-leader"),
    );
    expect(missing?.status).toBe("fail");
    expect(missing?.fix).toBe(
      `ln -s ${path.join(fx.home, ".claude", "CLAUDE.md")} ${path.join(fx.home, ".claude-leader", "CLAUDE.md")}`,
    );
    expect(missing?.why).toMatch(/global CLAUDE\.md/);
  });

  it("passes a slot whose CLAUDE.md and projects/ resolve to the canonical ones", async () => {
    const fx = makeFixture();
    writeConfig(fx, poolConfig(fx));
    const dir = path.join(fx.home, ".claude-leader");
    makeAccountDir(dir);
    link(path.join(fx.home, ".claude", "CLAUDE.md"), path.join(dir, "CLAUDE.md"));
    link(path.join(fx.home, ".claude", "projects"), path.join(dir, "projects"));
    const findings = await accountConfigCheck.run(makeContext(fx), Date.now() + 5000);
    const leader = findings.filter((f) => f.title.includes(".claude-leader"));
    expect(leader.map((f) => f.status)).toEqual(["ok", "ok"]);
  });

  it("flags a separate CLAUDE.md copy: warn when identical, fail when different", async () => {
    const fx = makeFixture();
    writeConfig(fx, poolConfig(fx));
    const same = path.join(fx.home, ".claude-leader");
    const other = path.join(fx.home, ".claude-personal");
    makeAccountDir(same);
    makeAccountDir(other);
    writeFileSync(path.join(same, "CLAUDE.md"), "# global rules\n");
    writeFileSync(path.join(other, "CLAUDE.md"), "# something else\n");
    const findings = await accountConfigCheck.run(makeContext(fx), Date.now() + 5000);
    const status = (dir: string) =>
      findings.find((f) => f.id === "account.claude-md" && f.title.includes(dir))?.status;
    expect(status(".claude-leader")).toBe("warn");
    expect(status(".claude-personal")).toBe("fail");
  });

  it("fails a private projects/ holding sessions and gives the migration commands", async () => {
    const fx = makeFixture();
    writeConfig(fx, poolConfig(fx));
    const dir = path.join(fx.home, ".claude-leader");
    makeAccountDir(dir);
    mkdirSync(path.join(dir, "projects", "-Users-x-repo"), { recursive: true });
    const findings = await accountConfigCheck.run(makeContext(fx), Date.now() + 5000);
    const projects = findings.find(
      (f) => f.id === "account.projects-link" && f.title.includes(".claude-leader"),
    );
    expect(projects?.status).toBe("fail");
    expect(projects?.detail).toMatch(/1 project folder/);
    expect(projects?.fix).toContain(
      `mv ${path.join(dir, "projects")} ${path.join(dir, "projects.pre-symlink")}`,
    );
    expect(projects?.fix).toContain(
      `ln -s ${path.join(fx.home, ".claude", "projects")} ${path.join(dir, "projects")}`,
    );
    expect(projects?.fix).toContain("cp -Rn");
    expect(projects?.why).toMatch(/No conversation found/);
  });

  it("warns on a missing projects/ and fails one that links elsewhere", async () => {
    const fx = makeFixture();
    writeConfig(fx, poolConfig(fx));
    makeAccountDir(path.join(fx.home, ".claude-leader"));
    const wrong = path.join(fx.home, ".claude-personal");
    makeAccountDir(wrong);
    mkdirSync(path.join(fx.home, "elsewhere"));
    link(path.join(fx.home, "elsewhere"), path.join(wrong, "projects"));
    const findings = await accountConfigCheck.run(makeContext(fx), Date.now() + 5000);
    const status = (dir: string) =>
      findings.find((f) => f.id === "account.projects-link" && f.title.includes(dir))?.status;
    expect(status(".claude-leader")).toBe("warn");
    expect(status(".claude-personal")).toBe("fail");
  });

  it("emits Windows commands on win32", async () => {
    const fx = makeFixture();
    writeConfig(fx, poolConfig(fx));
    makeAccountDir(path.join(fx.home, ".claude-leader"));
    const findings = await accountConfigCheck.run(
      makeContext(fx, {}, { platform: "win32" }),
      Date.now() + 5000,
    );
    const missing = findings.find(
      (f) => f.id === "account.claude-md" && f.title.includes(".claude-leader"),
    );
    expect(missing?.fix).toMatch(/^mklink /);
  });
});

describe("account login", () => {
  it("fails signed-out, warns on never-signed-in, and fails a missing credential", async () => {
    const fx = makeFixture();
    writeConfig(fx, poolConfig(fx));
    makeAccountDir(path.join(fx.home, ".claude-leader"), { signedIn: false });
    makeAccountDir(path.join(fx.home, ".claude-personal"), { signedIn: null });
    makeAccountDir(path.join(fx.home, ".claude"), { email: "backup@example.com" });
    const probes = fakeProbes({
      hasCredentials: async ({ configDir }) => !configDir.endsWith(".claude"),
    });
    const findings = await accountLoginCheck.run(
      makeContext(fx, {}, { probes }),
      Date.now() + 5000,
    );
    const status = (dir: string) => findings.find((f) => f.title.includes(`${dir} (`))?.status;
    expect(status(".claude-leader")).toBe("fail");
    expect(status(".claude-personal")).toBe("warn");
    expect(status("/.claude")).toBe("fail");
    expect(findings.find((f) => f.title.includes(".claude-leader"))?.fix).toBe(
      `CLAUDE_CONFIG_DIR=${path.join(fx.home, ".claude-leader")} claude /login`,
    );
  });

  it("warns when two config dirs are signed into one login", async () => {
    const fx = makeFixture();
    writeConfig(fx, poolConfig(fx));
    makeAccountDir(path.join(fx.home, ".claude-leader"), { email: "same@example.com" });
    makeAccountDir(path.join(fx.home, ".claude-personal"), { email: "same@example.com" });
    makeAccountDir(path.join(fx.home, ".claude"), { email: "other@example.com" });
    const findings = await accountLoginCheck.run(makeContext(fx), Date.now() + 5000);
    const twin = findings.find((f) => f.title.includes("same login"));
    expect(twin?.status).toBe("warn");
    expect(twin?.why).toMatch(/one budget/);
  });

  it("keeps a provider's own keychainService override", async () => {
    const fx = makeFixture();
    const config = poolConfig(fx) as {
      agents: { providers: Record<string, { params?: unknown }> };
    };
    config.agents.providers["claude"]!.params = {
      accountPool: { keychainService: "custom-service" },
    };
    writeConfig(fx, config);
    makeAccountDir(path.join(fx.home, ".claude-leader"));
    const asked: Array<string | undefined> = [];
    await accountLoginCheck.run(
      makeContext(
        fx,
        {},
        {
          probes: fakeProbes({
            hasCredentials: async (i) => (asked.push(i.keychainService), true),
          }),
        },
      ),
      Date.now() + 5000,
    );
    expect(asked).toContain("custom-service");
  });
});

describe("account budget", () => {
  const usage = (providerId: string, usedPct: number | null, extra: object = {}) => ({
    providerId,
    displayName: providerId,
    status: "available" as const,
    planLabel: null,
    windows: [{ id: "five_hour", label: "5h", usedPct, resetsAt: "2026-09-23T20:00:00.000Z" }],
    ...extra,
  });

  it("reports near-cap, capped, healthy and unreadable windows", async () => {
    const fx = makeFixture();
    writeConfig(fx, poolConfig(fx));
    const ctx = makeContext(
      fx,
      {
        usage: [
          usage("claude", 93),
          usage("claude-personal", 100),
          usage("claude-backup", 12),
          usage("codex", 99),
        ],
      },
      { now: () => Date.parse("2026-09-23T18:00:00.000Z") },
    );
    const findings = await accountBudgetCheck.run(ctx, Date.now() + 5000);
    const status = (id: string) => findings.find((f) => f.title.startsWith(id))?.status;
    expect(status("claude:")).toBe("warn");
    expect(status("claude-personal")).toBe("fail");
    expect(status("claude-backup")).toBe("ok");
    expect(findings.some((f) => f.title.startsWith("codex"))).toBe(false);
    expect(findings.find((f) => f.title.startsWith("claude-personal"))?.title).toMatch(
      /resets in 2 h/,
    );

    const unreadable = await accountBudgetCheck.run(
      makeContext(fx, { usage: [usage("claude", null, { status: "error", error: "HTTP 401" })] }),
      Date.now() + 5000,
    );
    expect(unreadable[0]?.status).toBe("warn");
    expect(unreadable[0]?.detail).toBe("HTTP 401");
  });

  it("skips, rather than passing, when the daemon returned no usage", async () => {
    const fx = makeFixture();
    const findings = await accountBudgetCheck.run(
      makeContext(fx, { usage: null }),
      Date.now() + 5000,
    );
    expect(findings[0]?.status).toBe("skip");
  });
});

describe("plugin check", () => {
  it("fails a plugin that failed to load and quotes the error and log tail", async () => {
    const fx = makeFixture();
    writeConfig(fx, {
      pluginsEnabled: true,
      plugins: { "claude-account-pool": { source: "directory", path: "/x" } },
    });
    const ctx = makeContext(fx, {
      plugins: [
        {
          id: "claude-account-pool",
          path: "/x",
          enabled: true,
          status: "failed",
          error: "Invalid URL",
        },
      ],
      pluginLogs: () => ["stderr: TypeError: Invalid URL"],
    });
    const findings = await pluginCheck.run(ctx, Date.now() + 5000);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe("fail");
    expect(findings[0]?.detail).toContain("Invalid URL");
    expect(findings[0]?.detail).toContain("log tail");
    expect(findings[0]?.fix).toContain("paseo plugin logs claude-account-pool");
  });

  it("fails a configured plugin the daemon never loaded, and pluginsEnabled:false", async () => {
    const fx = makeFixture();
    writeConfig(fx, {
      pluginsEnabled: false,
      plugins: { pool: { source: "directory", path: "/x" } },
    });
    const findings = await pluginCheck.run(makeContext(fx, { plugins: [] }), Date.now() + 5000);
    expect(byStatus(findings, "fail")).toHaveLength(2);
  });

  it("passes a running plugin whose path exists, skips when plugin state is unknown", async () => {
    const fx = makeFixture();
    writeConfig(fx, {
      pluginsEnabled: true,
      plugins: { pool: { source: "directory", path: fx.home } },
    });
    const running = await pluginCheck.run(
      makeContext(fx, {
        plugins: [{ id: "pool", path: fx.home, enabled: true, status: "running" }],
      }),
      Date.now() + 5000,
    );
    expect(running.map((f) => f.status)).toEqual(["ok"]);
    const unknown = await pluginCheck.run(makeContext(fx, { plugins: null }), Date.now() + 5000);
    expect(unknown.some((f) => f.status === "skip")).toBe(true);
  });
});

describe("daemon build vs staged bundle", () => {
  function bundle(fx: { home: string }, mtime: Date, version = "0.8.0") {
    const app = path.join(fx.home, "Bozeo.app");
    mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    writeFileSync(path.join(app, "Contents", "Resources", "app.asar"), "x");
    utimesSync(path.join(app, "Contents", "Resources", "app.asar"), mtime, mtime);
    writeFileSync(
      path.join(app, "Contents", "Info.plist"),
      `<plist><dict><key>CFBundleShortVersionString</key>\n<string>${version}</string></dict></plist>`,
    );
    return path.join(app, "Contents", "MacOS", "Bozeo");
  }

  it("warns when the bundle was staged after the daemon started", async () => {
    const fx = makeFixture();
    const execPath = bundle(fx, new Date("2026-09-23T19:00:00Z"));
    const ctx = makeContext(fx, {
      daemon: { version: "0.8.0", startedAt: "2026-09-23T12:00:00.000Z", pid: 1, execPath },
    });
    const [result] = await buildCheck.run(ctx, Date.now() + 5000);
    expect(result?.status).toBe("warn");
    expect(result?.detail).toMatch(/7 h after the daemon started/);
    expect(result?.fix).toContain("paseo daemon restart");
  });

  it("warns on a version mismatch even when the mtimes look fine", async () => {
    const fx = makeFixture();
    const execPath = bundle(fx, new Date("2026-09-23T10:00:00Z"), "0.9.0");
    const ctx = makeContext(fx, {
      daemon: { version: "0.8.0", startedAt: "2026-09-23T12:00:00.000Z", pid: 1, execPath },
    });
    expect((await buildCheck.run(ctx, Date.now() + 5000))[0]?.status).toBe("warn");
  });

  it("passes when the daemon started after the bundle, fails with no daemon, skips with no bundle", async () => {
    const fx = makeFixture();
    const execPath = bundle(fx, new Date("2026-09-23T10:00:00Z"));
    const ok = makeContext(fx, {
      daemon: { version: "0.8.0", startedAt: "2026-09-23T12:00:00.000Z", pid: 1, execPath },
    });
    expect((await buildCheck.run(ok, Date.now() + 5000))[0]?.status).toBe("ok");
    const down = makeContext(fx, { daemon: null });
    expect((await buildCheck.run(down, Date.now() + 5000))[0]?.status).toBe("fail");
    const none = makeContext(makeFixture(), {}, { platform: "linux" });
    expect((await buildCheck.run(none, Date.now() + 5000))[0]?.status).toBe("skip");
  });
});

describe("disk", () => {
  const free = (gib: number) =>
    fakeProbes({ statfs: async () => ({ freeBytes: gib * GIB, totalBytes: 900 * GIB }) });

  it("fails below the floor, warns within 1.5x of it, passes above", async () => {
    const fx = makeFixture();
    const run = async (gib: number) =>
      (await diskCheck.run(makeContext(fx, {}, { probes: free(gib) }), 0))[0]!;
    expect((await run(2.5)).status).toBe("fail");
    expect((await run(25)).status).toBe("warn");
    expect((await run(100)).status).toBe("ok");
    expect((await run(2.5)).title).toMatch(/2\.5 GB free of 900 GB/);
  });

  it("uses the artifact janitor's configured floor", async () => {
    const fx = makeFixture();
    writeConfig(fx, { agents: { artifactJanitor: { diskGuard: { minFreeBytes: 60 * GIB } } } });
    const [result] = await diskCheck.run(makeContext(fx, {}, { probes: free(50) }), 0);
    expect(result?.status).toBe("fail");
    expect(result?.detail).toContain("60.0 GB floor");
  });
});

describe("config keys", () => {
  it("names a key the running schema does not know", async () => {
    const fx = makeFixture();
    writeConfig(fx, { agents: { refocus: { enabled: true, notAKey: 1 }, madeUpSection: {} } });
    const [result] = await configCheck.run(makeContext(fx), 0);
    expect(result?.status).toBe("fail");
    expect(result?.detail).toContain("unknown key agents.refocus.notAKey");
    expect(result?.detail).toContain("unknown key agents.madeUpSection");
    expect(result?.fix).toMatch(/only once the daemon has that build/);
  });

  it("accepts a valid config, reports broken JSON, and flags CLI-side checking", async () => {
    const fx = makeFixture();
    writeConfig(fx, { version: 1, agents: { refocus: { enabled: false } } });
    expect((await configCheck.run(makeContext(fx), 0))[0]?.status).toBe("ok");

    const cli = await configCheck.run(makeContext(fx, { source: "cli" }), 0);
    expect(cli.map((f) => f.id)).toEqual(["config.keys", "config.keys.scope"]);
    expect(cli[1]?.status).toBe("warn");

    writeFileSync(path.join(fx.paseoHome, "config.json"), "{ nope");
    const broken = await configCheck.run(makeContext(fx), 0);
    expect(broken[0]?.status).toBe("fail");
    expect(broken[0]?.detail).toMatch(/Invalid JSON/);
  });
});

describe("mcp gateway", () => {
  it("fails a critical OAuth server with no stored login and passes ones that have one", async () => {
    const fx = makeFixture();
    writeConfig(fx, {
      mcpGateway: {
        enabled: true,
        servers: {
          zeeq: { url: "https://z", transport: "http", auth: "oauth", critical: true },
          notion: { url: "https://n", transport: "http", auth: "oauth" },
          figma: { url: "https://f", transport: "http", auth: "oauth" },
        },
      },
    });
    mkdirSync(path.join(fx.paseoHome, "mcp-gateway"));
    writeFileSync(
      path.join(fx.paseoHome, "mcp-gateway", "tokens.json"),
      JSON.stringify({
        version: 1,
        servers: { notion: { tokens: { access_token: "secret-value" } } },
      }),
    );
    const findings = await mcpGatewayCheck.run(makeContext(fx), 0);
    expect(findings.find((f) => f.title.startsWith("zeeq"))?.status).toBe("fail");
    expect(findings.find((f) => f.title.startsWith("figma"))?.status).toBe("warn");
    expect(findings.some((f) => f.title.startsWith("notion"))).toBe(false);
    expect(JSON.stringify(findings)).not.toContain("secret-value");
  });
});

describe("skills drift", () => {
  function skill(dir: string, name: string, body = "body", frontmatterName = name) {
    mkdirSync(path.join(dir, name), { recursive: true });
    writeFileSync(
      path.join(dir, name, "SKILL.md"),
      `---\nname: ${frontmatterName}\ndescription: does a thing\n---\n${body}\n`,
    );
  }

  it("passes a symlinked skills/, and fails a drifted private copy naming what differs", async () => {
    const fx = makeFixture();
    writeConfig(fx, poolConfig(fx));
    const canonical = path.join(fx.home, ".claude", "skills");
    skill(canonical, "alpha");
    skill(canonical, "beta");
    const linked = path.join(fx.home, ".claude-leader");
    makeAccountDir(linked);
    link(canonical, path.join(linked, "skills"));
    const copy = path.join(fx.home, ".claude-personal");
    makeAccountDir(copy);
    skill(path.join(copy, "skills"), "alpha", "edited");
    skill(path.join(copy, "skills"), "stray");
    const findings = (await skillsCheck.run(makeContext(fx), 0)).filter(
      (f) => f.id === "skills.mirror",
    );
    expect(findings.find((f) => f.title.includes(".claude-leader"))?.status).toBe("ok");
    const drifted = findings.find((f) => f.title.includes(".claude-personal"));
    expect(drifted?.status).toBe("fail");
    expect(drifted?.detail).toContain("missing here: beta");
    expect(drifted?.detail).toContain("different content: alpha");
    expect(drifted?.detail).toContain("only here: stray");
    expect(drifted?.fix).toContain(`ln -s ${canonical} ${path.join(copy, "skills")}`);
  });

  it("lints canonical skills: bad frontmatter, dead symlink, a path in a directory that is gone", async () => {
    const fx = makeFixture();
    const canonical = path.join(fx.home, ".claude", "skills");
    skill(canonical, "good", "See `~/.paseo/` and `~/.claude/account-exhausted-until`.");
    skill(canonical, "renamed", "x", "other-name");
    skill(canonical, "stale", "Look at `~/retired-project/src/main.ts` first.");
    symlinkSync(path.join(fx.home, "nowhere"), path.join(canonical, "dead"));
    const result = (await skillsCheck.run(makeContext(fx), 0)).find((f) => f.id === "skills.lint");
    expect(result?.status).toBe("warn");
    expect(result?.detail).toContain('renamed: frontmatter name is "other-name"');
    expect(result?.detail).toContain("dead: symlink target is gone");
    expect(result?.detail).toContain(
      "stale: names path(s) that no longer exist — ~/retired-project/src/main.ts",
    );
    expect(result?.detail).not.toContain("good:");
  });

  it("does not flag a path the skill labels as another platform's", async () => {
    const fx = makeFixture();
    const canonical = path.join(fx.home, ".claude", "skills");
    skill(
      canonical,
      "help",
      [
        "- Linux desktop log: `~/.config/Paseo/logs/main.log`",
        "- Windows desktop log: `~/AppData/Roaming/Paseo/logs/main.log`",
        "- macOS desktop log: `~/Library/Logs/Paseo/main.log`",
      ].join("\n"),
    );
    const onMac = (await skillsCheck.run(makeContext(fx, {}, { platform: "darwin" }), 0)).find(
      (f) => f.id === "skills.lint",
    );
    expect(onMac?.detail ?? "").not.toContain("~/.config/Paseo");
    expect(onMac?.detail ?? "").not.toContain("~/AppData");
    expect(onMac?.detail).toContain("~/Library/Logs/Paseo/main.log");

    const onLinux = (await skillsCheck.run(makeContext(fx, {}, { platform: "linux" }), 0)).find(
      (f) => f.id === "skills.lint",
    );
    expect(onLinux?.detail).toContain("~/.config/Paseo/logs/main.log");
    expect(onLinux?.detail ?? "").not.toContain("~/Library/Logs");
  });

  it("reports drift between the bundle and what Paseo installed", async () => {
    const fx = makeFixture();
    const ctx = makeContext(fx, {
      loadSkillsStatus: async () => ({
        ops: [
          { kind: "update", name: "paseo" },
          { kind: "delete", name: "paseo-chat" },
        ],
      }),
    });
    const bundle = (await skillsCheck.run(ctx, 0)).find((f) => f.id === "skills.bundle");
    expect(bundle?.status).toBe("warn");
    expect(bundle?.detail).toContain("differ from the bundle: paseo");
    expect(bundle?.detail).toContain("retired but still installed: paseo-chat");
  });
});

describe("runner", () => {
  it("gives every check its own deadline: a hung check is skipped, the rest still answer", async () => {
    const fx = makeFixture();
    const ctx = makeContext(fx);
    const findings = await runDoctorChecks(ctx, [
      {
        id: "hangs",
        category: "test",
        timeoutMs: 30,
        run: () => new Promise<DoctorFinding[]>(() => undefined),
      },
      {
        id: "throws",
        category: "test",
        timeoutMs: 1000,
        run: async () => {
          throw new Error("boom");
        },
      },
      {
        id: "fine",
        category: "test",
        timeoutMs: 1000,
        run: async () => [{ id: "fine", category: "test", status: "ok", title: "fine" }],
      },
    ]);
    const hung = findings.find((f) => f.id === "hangs");
    expect(hung?.status).toBe("skip");
    expect(hung?.timedOutAfterMs).toBe(30);
    expect(findings.find((f) => f.id === "throws")).toMatchObject({
      status: "warn",
      detail: "boom",
    });
    expect(findings.find((f) => f.id === "fine")?.status).toBe("ok");
  });

  it("changes nothing: every check over a broken fixture leaves the tree byte-identical", async () => {
    const fx = makeFixture();
    writeConfig(fx, {
      ...poolConfig(fx),
      agents: { ...(poolConfig(fx).agents as object), refocus: { bogus: 1 } },
    });
    makeAccountDir(path.join(fx.home, ".claude-leader"), { signedIn: false });
    mkdirSync(path.join(fx.home, ".claude-leader", "projects", "p"), { recursive: true });
    mkdirSync(path.join(fx.home, ".claude-personal", "skills", "a"), { recursive: true });
    mkdirSync(path.join(fx.paseoHome, "worktrees", "proj", "wt"), { recursive: true });
    const before = snapshotTree(fx.home);
    const findings = await runDoctorChecks(makeContext(fx, { plugins: [] }));
    expect(findings.length).toBeGreaterThan(5);
    expect(byStatus(findings, "fail").length).toBeGreaterThan(2);
    expect(snapshotTree(fx.home)).toEqual(before);
  });

  it("registers every check under a unique id", () => {
    const ids = DOCTOR_CHECKS.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
