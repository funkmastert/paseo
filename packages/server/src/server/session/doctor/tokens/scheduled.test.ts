import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DoctorContext, DoctorProbes } from "../context.js";
import { fakeProbes, makeContext, makeFixture, type Fixture } from "../test-support.js";
import { createScheduledCheck } from "./scheduled.js";
import type { TokenAuditRow } from "./types.js";

type ExecResult = { stdout: string; stderr: string; code: number | null } | null;

const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", code: 0 });

const FORK_DAEMON_PRINT = [
  "gui/501/sh.paseo.fork-daemon = {",
  "\tactive count = 0",
  "\tpath = /Users/x/Library/LaunchAgents/sh.paseo.fork-daemon.plist",
  "\tstate = spawn scheduled",
  "\tproperties = keepalive | runatload | inferred program",
  "\truns = 305",
  "\tlast exit code = 1",
  "}",
].join("\n");

interface Setup {
  fx: Fixture;
  ctx: DoctorContext;
  calls: string[];
}

function setup(
  options: {
    platform?: NodeJS.Platform;
    crontab?: ExecResult;
    plists?: Record<string, unknown>;
    launchctl?: Record<string, ExecResult>;
    uid?: string | null;
  } = {},
): Setup {
  const fx = makeFixture();
  const calls: string[] = [];
  const plistDir = path.join(fx.home, "Library", "LaunchAgents");
  mkdirSync(plistDir, { recursive: true });
  const byFile = new Map<string, unknown>();
  for (const [name, json] of Object.entries(options.plists ?? {})) {
    const file = path.join(plistDir, `${name}.plist`);
    writeFileSync(file, "<plist/>");
    byFile.set(file, json);
  }
  const exec: DoctorProbes["exec"] = async (file, args) => {
    calls.push([file, ...args].join(" "));
    if (file === "crontab") {
      return options.crontab !== undefined
        ? options.crontab
        : { stdout: "", stderr: "no crontab", code: 1 };
    }
    if (file === "plutil") {
      const json = byFile.get(args[args.length - 1]);
      return json === undefined ? null : ok(JSON.stringify(json));
    }
    if (file === "launchctl") return options.launchctl?.[args[1] ?? args[0] ?? ""] ?? null;
    return null;
  };
  const base = makeContext(
    fx,
    {},
    { probes: fakeProbes({ exec }), platform: options.platform ?? "darwin", now: () => NOW },
  );
  const ctx: DoctorContext = {
    ...base,
    env: options.uid === null ? {} : { __TOKEN_AUDIT_UID: options.uid ?? "501" },
  };
  return { fx, ctx, calls };
}

function writeSchedule(fx: Fixture, id: string, overrides: Record<string, unknown> = {}): void {
  const dir = path.join(fx.paseoHome, "schedules");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      name: id,
      prompt: "check the build",
      cadence: { type: "every", everyMs: 1_800_000 },
      target: { type: "new-agent" },
      status: "active",
      lastRunAt: null,
      nextRunAt: null,
      runs: [],
      ...overrides,
    }),
  );
}

function lifetime(lifetimeMs: number | null, oneHourTokens = 0, fiveMinTokens = 0) {
  return createScheduledCheck({
    measureCacheLifetime: async () => ({ lifetimeMs, oneHourTokens, fiveMinTokens }),
  });
}

function byKey(rows: TokenAuditRow[], key: string): TokenAuditRow {
  const found = rows.find((r) => r.key === key);
  if (!found) throw new Error(`no row ${key} in ${rows.map((r) => r.key).join(", ")}`);
  return found;
}

const DEADLINE = NOW + 60_000;

describe("tokens.scheduled: paseo schedules", () => {
  it("flags active schedules whose interval exceeds a 5-minute cache and ignores paused ones", async () => {
    const { fx, ctx } = setup();
    writeSchedule(fx, "half-hour");
    writeSchedule(fx, "hourly", { cadence: { type: "cron", expression: "0 * * * *" } });
    writeSchedule(fx, "asleep", { status: "paused" });
    const rows = await lifetime(300_000, 0, 9000).measure(ctx, DEADLINE);

    const half = byKey(rows, "scheduled:paseo:half-hour");
    expect(half.item).toBe("scheduled");
    expect(half.severity).toBe("AMBER");
    expect(half.finding).toBe("paseo half-hour: every 30 min");
    expect(half.evidence).toContain("1800 s");
    expect(half.evidence).toContain("300 s");
    expect(half.evidence).toContain("9000");
    expect(byKey(rows, "scheduled:paseo:hourly").severity).toBe("AMBER");
    expect(byKey(rows, "scheduled:paseo:hourly").evidence).toContain("3600 s");
    expect(rows.some((r) => r.key === "scheduled:paseo:asleep")).toBe(false);
  });

  it("is green when the interval fits inside a 1-hour cache", async () => {
    const { fx, ctx } = setup();
    writeSchedule(fx, "half-hour");
    writeSchedule(fx, "hourly", { cadence: { type: "cron", expression: "0 * * * *" } });
    const rows = await lifetime(3_600_000, 5000, 100).measure(ctx, DEADLINE);
    expect(byKey(rows, "scheduled:paseo:half-hour").severity).toBe("GREEN");
    expect(byKey(rows, "scheduled:paseo:hourly").severity).toBe("GREEN");
    expect(byKey(rows, "scheduled:summary").severity).toBe("GREEN");
  });

  it("is UNKNOWN, and still lists the job, when the cache lifetime could not be measured", async () => {
    const { fx, ctx } = setup();
    writeSchedule(fx, "half-hour");
    const rows = await lifetime(null).measure(ctx, DEADLINE);
    const r = byKey(rows, "scheduled:paseo:half-hour");
    expect(r.severity).toBe("UNKNOWN");
    expect(r.evidence).toContain("1800 s");
  });

  it("is UNKNOWN when measuring the lifetime throws", async () => {
    const { fx, ctx } = setup();
    writeSchedule(fx, "half-hour");
    const check = createScheduledCheck({
      measureCacheLifetime: async () => {
        throw new Error("boom");
      },
    });
    const rows = await check.measure(ctx, DEADLINE);
    expect(byKey(rows, "scheduled:paseo:half-hour").severity).toBe("UNKNOWN");
  });

  it("reports an unparseable cron expression as UNKNOWN with the expression as evidence", async () => {
    const { fx, ctx } = setup();
    writeSchedule(fx, "bad", { cadence: { type: "cron", expression: "61 * * * *" } });
    const rows = await lifetime(300_000).measure(ctx, DEADLINE);
    const r = byKey(rows, "scheduled:paseo:bad");
    expect(r.severity).toBe("UNKNOWN");
    expect(r.evidence).toContain("61 * * * *");
  });

  it("uses the smallest gap between fires for an irregular cron", async () => {
    const { fx, ctx } = setup();
    writeSchedule(fx, "irregular", { cadence: { type: "cron", expression: "0,10 9 * * *" } });
    const rows = await lifetime(300_000).measure(ctx, DEADLINE);
    expect(byKey(rows, "scheduled:paseo:irregular").evidence).toContain("600 s");
  });
});

describe("tokens.scheduled: crontab", () => {
  it("treats 'no crontab' as zero entries", async () => {
    const { ctx } = setup();
    const rows = await lifetime(300_000).measure(ctx, DEADLINE);
    expect(rows.filter((r) => r.key.startsWith("scheduled:cron"))).toEqual([]);
    expect(byKey(rows, "scheduled:summary").evidence).toContain("cron 0");
  });

  it("parses entries, flags the claude ones and truncates the command", async () => {
    const long = `/usr/local/bin/claude -p ${"x".repeat(200)}`;
    const { ctx } = setup({
      crontab: ok(
        [
          "# a comment",
          "MAILTO=me@example.com",
          "",
          `*/10 * * * * ${long}`,
          "*/10 * * * * /usr/bin/backup --all",
          "@hourly /usr/local/bin/paseo run tick",
          "@reboot /usr/bin/say hi",
          "99 * * * * /usr/bin/broken",
        ].join("\n"),
      ),
    });
    const rows = await lifetime(300_000, 0, 500).measure(ctx, DEADLINE);
    const cronRows = rows.filter((r) => r.key.startsWith("scheduled:cron:"));
    expect(cronRows).toHaveLength(5);

    const claude = cronRows.find((r) => r.finding.includes("claude"));
    expect(claude?.severity).toBe("AMBER");
    expect(claude?.evidence).toContain("600 s");
    expect(claude?.evidence).not.toContain("x".repeat(121));

    const backup = cronRows.find((r) => r.finding.includes("backup"));
    expect(backup?.severity).toBe("GREEN");
    expect(backup?.evidence).toContain("does not reference claude");

    expect(cronRows.find((r) => r.finding.includes("tick"))?.severity).toBe("AMBER");
    const reboot = cronRows.find((r) => r.finding.includes("say hi"));
    expect(reboot?.severity).toBe("GREEN");
    expect(reboot?.evidence).toContain("@reboot");
    const broken = cronRows.find((r) => r.evidence.includes("99 * * * *"));
    expect(broken?.severity).toBe("UNKNOWN");
  });

  it("keeps stable keys for the same line", async () => {
    const line = "*/10 * * * * /usr/bin/backup --all";
    const a = await lifetime(300_000).measure(setup({ crontab: ok(line) }).ctx, DEADLINE);
    const b = await lifetime(3_600_000).measure(setup({ crontab: ok(line) }).ctx, DEADLINE);
    expect(a.find((r) => r.key.startsWith("scheduled:cron:"))?.key).toBe(
      b.find((r) => r.key.startsWith("scheduled:cron:"))?.key,
    );
  });

  it("is UNKNOWN when crontab could not run at all", async () => {
    const { ctx } = setup({ crontab: null });
    const rows = await lifetime(300_000).measure(ctx, DEADLINE);
    expect(byKey(rows, "scheduled:cron").severity).toBe("UNKNOWN");
  });
});

describe("tokens.scheduled: launchd", () => {
  it("marks the runs=305 / exit 1 KeepAlive agent RED", async () => {
    const fx0 = makeFixture();
    const script = path.join(fx0.home, "fork-daemon.sh");
    writeFileSync(script, "#!/bin/sh\nexec paseo daemon\n");
    const { ctx } = setup({
      plists: {
        "sh.paseo.fork-daemon": {
          Label: "sh.paseo.fork-daemon",
          ProgramArguments: ["/bin/sh", script],
          KeepAlive: true,
          RunAtLoad: true,
          ThrottleInterval: 30,
          EnvironmentVariables: { ANTHROPIC_API_KEY: "sk-ant-SECRET" },
        },
      },
      launchctl: { "gui/501/sh.paseo.fork-daemon": ok(FORK_DAEMON_PRINT) },
    });
    const rows = await lifetime(300_000).measure(ctx, DEADLINE);
    const crash = byKey(rows, "scheduled:crashloop:sh.paseo.fork-daemon");
    expect(crash.severity).toBe("RED");
    expect(crash.evidence).toContain("runs = 305");
    expect(crash.evidence).toContain("last exit code = 1");
    expect(crash.cost).toContain("2880");
    expect(crash.cost).toContain("bound");
    expect(JSON.stringify(rows)).not.toContain("SECRET");
  });

  it("uses a 10 s throttle bound when ThrottleInterval is absent", async () => {
    const { ctx } = setup({
      plists: {
        "a.b": {
          Label: "a.b",
          ProgramArguments: ["/bin/sh"],
          KeepAlive: { SuccessfulExit: false },
        },
      },
      launchctl: { "gui/501/a.b": ok("\truns = 60\n\tlast exit code = 2\n") },
    });
    const rows = await lifetime(300_000).measure(ctx, DEADLINE);
    const crash = byKey(rows, "scheduled:crashloop:a.b");
    expect(crash.severity).toBe("RED");
    expect(crash.cost).toContain("8640");
  });

  it("marks a KeepAlive job whose script is gone RED and names the path", async () => {
    const { fx, ctx } = setup({
      plists: {
        "gone.job": {
          Label: "gone.job",
          ProgramArguments: [
            "/bin/sh",
            "/nonexistent/dir/run.sh",
            "--out",
            "/nonexistent/out.json",
          ],
          KeepAlive: true,
        },
      },
      launchctl: { "gui/501/gone.job": ok("\truns = 189\n\tlast exit code = 127\n") },
    });
    void fx;
    const rows = await lifetime(300_000).measure(ctx, DEADLINE);
    const crash = byKey(rows, "scheduled:crashloop:gone.job");
    expect(crash.severity).toBe("RED");
    expect(crash.evidence).toContain("/nonexistent/dir/run.sh");
    expect(crash.evidence).not.toContain("/nonexistent/out.json");
    expect(crash.evidence).toContain("runs = 189");
  });

  it("marks a young failing job AMBER and a clean one not flagged", async () => {
    const { ctx } = setup({
      plists: {
        "young.fail": { Label: "young.fail", ProgramArguments: ["/bin/sh"], StartInterval: 3600 },
        "clean.job": { Label: "clean.job", ProgramArguments: ["/bin/sh"], StartInterval: 3600 },
      },
      launchctl: {
        "gui/501/young.fail": ok("\truns = 3\n\tlast exit code = 1\n"),
        "gui/501/clean.job": ok("\truns = 900\n\tlast exit code = (never exited)\n"),
      },
    });
    const rows = await lifetime(3_600_000).measure(ctx, DEADLINE);
    expect(byKey(rows, "scheduled:crashloop:young.fail").severity).toBe("AMBER");
    expect(rows.some((r) => r.key === "scheduled:crashloop:clean.job")).toBe(false);
  });

  it("derives intervals from StartInterval and StartCalendarInterval", async () => {
    const { fx, ctx } = setup({
      plists: {
        "every.15": {
          Label: "every.15",
          ProgramArguments: ["/usr/local/bin/claude", "-p", "hi"],
          StartInterval: 900,
        },
        "daily.job": {
          Label: "daily.job",
          ProgramArguments: ["/usr/local/bin/claude"],
          StartCalendarInterval: { Hour: 9, Minute: 30 },
        },
        "weekly.job": {
          Label: "weekly.job",
          ProgramArguments: ["/usr/local/bin/claude"],
          StartCalendarInterval: { Hour: 9, Minute: 30, Weekday: 1 },
        },
        "twice.daily": {
          Label: "twice.daily",
          ProgramArguments: ["/usr/local/bin/claude"],
          StartCalendarInterval: [
            { Hour: 8, Minute: 0 },
            { Hour: 20, Minute: 0 },
          ],
        },
        "no.claude": {
          Label: "no.claude",
          ProgramArguments: ["/usr/bin/backup"],
          StartInterval: 900,
        },
      },
    });
    void fx;
    const rows = await lifetime(300_000, 0, 42).measure(ctx, DEADLINE);
    const every = byKey(rows, "scheduled:launchd:every.15");
    expect(every.severity).toBe("AMBER");
    expect(every.evidence).toContain("900 s");
    expect(byKey(rows, "scheduled:launchd:daily.job").evidence).toContain("86400 s");
    expect(byKey(rows, "scheduled:launchd:weekly.job").evidence).toContain("604800 s");
    expect(byKey(rows, "scheduled:launchd:twice.daily").evidence).toContain("43200 s");
    const nc = byKey(rows, "scheduled:launchd:no.claude");
    expect(nc.severity).toBe("GREEN");
    expect(nc.evidence).toContain("does not reference claude");
  });

  it("reads a script argument to decide whether the job calls claude", async () => {
    const fx0 = makeFixture();
    const script = path.join(fx0.home, "tick.sh");
    writeFileSync(script, "#!/bin/sh\nclaude -p 'summarize'\n");
    const { ctx } = setup({
      plists: {
        "script.job": {
          Label: "script.job",
          ProgramArguments: ["/bin/sh", script],
          StartInterval: 900,
        },
      },
    });
    const rows = await lifetime(300_000).measure(ctx, DEADLINE);
    expect(byKey(rows, "scheduled:launchd:script.job").severity).toBe("AMBER");
  });

  it("lists a job with no timer without calling it unknown", async () => {
    const { ctx } = setup({
      plists: {
        "boot.only": { Label: "boot.only", ProgramArguments: ["/bin/sh"], RunAtLoad: true },
      },
    });
    const rows = await lifetime(300_000).measure(ctx, DEADLINE);
    const r = byKey(rows, "scheduled:launchd:boot.only");
    expect(r.severity).toBe("GREEN");
    expect(r.evidence).toContain("no StartInterval or StartCalendarInterval");
  });

  it("does not call launchctl when the uid is unknown", async () => {
    const { ctx, calls } = setup({
      uid: null,
      plists: { "x.y": { Label: "x.y", ProgramArguments: ["/bin/sh"], StartInterval: 60 } },
    });
    // process.getuid exists on the test host, so only assert the injected path here.
    await lifetime(300_000).measure({ ...ctx, env: { __TOKEN_AUDIT_UID: "" } }, DEADLINE);
    expect(calls.some((c) => c.startsWith("launchctl print gui//"))).toBe(false);
  });

  it("is UNKNOWN for a plist plutil cannot convert", async () => {
    const { fx, ctx } = setup();
    const dir = path.join(fx.home, "Library", "LaunchAgents");
    writeFileSync(path.join(dir, "broken.plist"), "garbage");
    const rows = await lifetime(300_000).measure(ctx, DEADLINE);
    expect(byKey(rows, "scheduled:launchd:broken.plist").severity).toBe("UNKNOWN");
  });
});

describe("tokens.scheduled: loaded without a plist", () => {
  it("finds a job launchd still holds whose plist is gone, from its runs and exit code", async () => {
    const { ctx } = setup({
      launchctl: {
        list: ok(
          [
            "PID\tStatus\tLabel",
            "-\t1\tsh.paseo.fork-daemon",
            "-\t0\tsh.bozeo.fine",
            "-\t78\tcom.apple.thing",
            "455\t0\tapplication.sh.paseo.desktop.1.2",
          ].join("\n"),
        ),
        "gui/501/sh.paseo.fork-daemon": ok(
          FORK_DAEMON_PRINT.replace(
            "\tstate",
            "\tprogram = /gone/node\n\targuments = {\n\t\t/gone/node\n\t\t/gone/fork.js\n\t}\n\tstate",
          ),
        ),
      },
    });
    const rows = await createScheduledCheck({
      measureCacheLifetime: async () => lifetime(3_600_000),
    }).measure(ctx, DEADLINE);
    const crash = byKey(rows, "scheduled:crashloop:sh.paseo.fork-daemon");
    expect(crash.severity).toBe("RED");
    expect(crash.evidence).toContain("runs = 305");
    expect(crash.evidence).toContain("missing paths: /gone/node, /gone/fork.js");
    expect(crash.evidence).toContain("loaded, file gone");
    expect(
      rows.some((r) => r.key.includes("com.apple.thing") || r.key.includes("sh.bozeo.fine")),
    ).toBe(false);
  });
});

describe("tokens.scheduled: platforms", () => {
  it("skips launchd off darwin and says so", async () => {
    const { ctx, calls } = setup({ platform: "linux" });
    const rows = await lifetime(300_000).measure(ctx, DEADLINE);
    const r = byKey(rows, "scheduled:launchd");
    expect(r.severity).toBe("UNKNOWN");
    expect(r.evidence).toContain("skipped because platform is linux");
    expect(calls.some((c) => c.startsWith("plutil"))).toBe(false);
    expect(calls.some((c) => c.startsWith("crontab"))).toBe(true);
  });

  it("says Task Scheduler was not probed on win32 and skips crontab", async () => {
    const { ctx, calls } = setup({ platform: "win32" });
    const rows = await lifetime(300_000).measure(ctx, DEADLINE);
    const r = byKey(rows, "scheduled:launchd");
    expect(r.evidence).toContain("skipped because platform is win32");
    expect(r.evidence).toContain("Task Scheduler not probed");
    expect(calls.some((c) => c.startsWith("crontab"))).toBe(false);
  });
});

describe("tokens.scheduled: summary and cap", () => {
  it("counts jobs by source, exceeded intervals and crash loops", async () => {
    const { fx, ctx } = setup({
      crontab: ok("*/10 * * * * /usr/local/bin/claude -p x"),
      plists: {
        "sh.paseo.fork-daemon": {
          Label: "sh.paseo.fork-daemon",
          ProgramArguments: ["/bin/sh"],
          KeepAlive: true,
        },
      },
      launchctl: { "gui/501/sh.paseo.fork-daemon": ok(FORK_DAEMON_PRINT) },
    });
    writeSchedule(fx, "half-hour");
    const rows = await lifetime(300_000, 0, 10).measure(ctx, DEADLINE);
    const summary = byKey(rows, "scheduled:summary");
    expect(summary.severity).toBe("RED");
    expect(summary.evidence).toContain("paseo 1");
    expect(summary.evidence).toContain("cron 1");
    expect(summary.evidence).toContain("launchd 1");
    expect(summary.evidence).toContain("2 exceed the cache lifetime");
    expect(summary.evidence).toContain("1 crash-looping");
  });

  it("caps job rows at 40, worst first, and says how many were omitted", async () => {
    const { fx, ctx } = setup();
    for (let i = 0; i < 45; i += 1) {
      writeSchedule(fx, `s${String(i).padStart(2, "0")}`, {
        cadence: { type: "every", everyMs: i === 44 ? 7_200_000 : 60_000 },
      });
    }
    const rows = await lifetime(300_000).measure(ctx, DEADLINE);
    const jobRows = rows.filter((r) => r.key.startsWith("scheduled:paseo:"));
    expect(jobRows).toHaveLength(40);
    expect(jobRows.some((r) => r.key === "scheduled:paseo:s44")).toBe(true);
    expect(byKey(rows, "scheduled:summary").evidence).toContain("5 omitted");
  });
});
