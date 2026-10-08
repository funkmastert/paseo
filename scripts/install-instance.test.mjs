import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const SRC = path.resolve(".");
const SCRIPT = path.join(SRC, "scripts", "install-instance.mjs");
const ENV_SH = path.join(SRC, "scripts", "install-env.sh");
const IS_POSIX = process.platform !== "win32";

function scratch() {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "install-instance-test-")));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function instance(args, env = {}) {
  const result = spawnSync("node", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

function writeConfig(home, listen) {
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "config.json"), `${JSON.stringify({ daemon: { listen } })}\n`);
}

test("check-env refuses an existing home written with a trailing slash or a dot segment", () => {
  const { dir, done } = scratch();
  try {
    const existing = path.join(dir, ".paseo");
    writeConfig(existing, "127.0.0.1:6767");
    for (const alias of [`${existing}/`, `${dir}/./.paseo`, path.join(existing, "sub")]) {
      const { code, out } = instance(["check-env"], {
        BOZEO_SRC: SRC,
        BOZEO_REPO: SRC,
        BOZEO_HOME: alias,
        BOZEO_PORT: "6790",
        BOZEO_PROTECT: `|${existing}|6767|`,
      });
      assert.equal(code, 1, alias);
      assert.equal(out.match(/STOP: BOZEO_HOME .* existing home/g)?.length, 1, alias);
    }
  } finally {
    done();
  }
});

test("check-env refuses port 6767 and ~/.paseo for an isolated instance, and prints canonical paths", () => {
  const { dir, done } = scratch();
  try {
    const base = {
      BOZEO_SRC: `${SRC}/`,
      BOZEO_REPO: SRC,
      BOZEO_HOME: `${dir}/new-home/`,
      BOZEO_PROTECT: `|${path.join(dir, "existing")}|`,
    };
    const defaultPort = instance(["check-env"], { ...base, BOZEO_PORT: "6767" });
    assert.equal(defaultPort.code, 1);
    assert.match(defaultPort.out, /default port/);
    const defaultHome = instance(["check-env"], {
      ...base,
      BOZEO_PORT: "6790",
      BOZEO_HOME: path.join(os.homedir(), ".paseo"),
    });
    assert.equal(defaultHome.code, 1);
    const ok = instance(["check-env"], { ...base, BOZEO_PORT: "6790" });
    assert.equal(ok.code, 0, ok.out);
    assert.deepEqual(ok.out.trim().split("\n"), [
      realpathSync(SRC),
      realpathSync(SRC),
      path.join(dir, "new-home"),
    ]);
  } finally {
    done();
  }
});

test("new-home writes the listen and the jobs-off block, and refuses a home that exists", () => {
  const { dir, done } = scratch();
  try {
    const home = path.join(dir, "bozeo-home");
    const created = instance(["new-home", `${home}/`, "127.0.0.1:6790", "--machine-jobs", "off"]);
    assert.equal(created.code, 0, created.out);
    const config = JSON.parse(readFileSync(path.join(home, "config.json"), "utf8"));
    assert.equal(config.daemon.listen, "127.0.0.1:6790");
    assert.equal(config.daemon.relay.enabled, false);
    assert.equal(config.agents.remediation.escalation.enabled, false);
    assert.equal(config.agents.tokenAudit.escalation.enabled, false);
    assert.equal(config.worktrees.diskSweeper.enabled, false);
    assert.equal(config.knowledgeBase.enabled, false);
    if (IS_POSIX) {
      assert.equal(statSync(home).mode & 0o777, 0o700);
      assert.equal(statSync(path.join(home, "config.json")).mode & 0o777, 0o600);
    }
    const before = readFileSync(path.join(home, "config.json"), "utf8");
    const again = instance(["new-home", home, "127.0.0.1:6791"]);
    assert.equal(again.code, 1);
    assert.match(again.out, /already exists/);
    assert.equal(readFileSync(path.join(home, "config.json"), "utf8"), before);
    assert.equal(instance(["config-listen", home, "127.0.0.1:6790"]).code, 0);
    assert.equal(instance(["config-listen", home, "127.0.0.1:6767"]).code, 1);
  } finally {
    done();
  }
});

test("config-listen reports invalid JSON by line only", () => {
  const { dir, done } = scratch();
  try {
    const home = path.join(dir, "home");
    mkdirSync(home);
    writeFileSync(path.join(home, "config.json"), `{\n "apiKey": 'sk-sentinel-never-print'\n}`);
    const { code, out } = instance(["config-listen", home, "127.0.0.1:6790"]);
    assert.equal(code, 1);
    assert.match(out, /not valid JSON at line 2/);
    assert.doesNotMatch(out, /sentinel/);
  } finally {
    done();
  }
});

// install-env.sh, sourced in bash, against a stub CLI that records how it was called.
function envShell(dir, script, extraEnv = {}) {
  const repo = path.join(dir, "repo");
  const home = path.join(dir, "home");
  const log = path.join(dir, "cli-calls.log");
  if (!existsSync(repo)) {
    mkdirSync(path.join(repo, "packages", "cli", "bin"), { recursive: true });
    mkdirSync(path.join(repo, "packages", "cli", "dist"), { recursive: true });
    writeFileSync(path.join(repo, "packages", "cli", "dist", "index.js"), "");
    const stub = path.join(repo, "packages", "cli", "bin", "paseo");
    writeFileSync(
      stub,
      [
        "#!/bin/sh",
        `echo "args: $*" >> "${log}"`,
        `env | grep -E '^(ANTHROPIC_|CLAUDE|GIT_EDITOR=|PASEO_AGENT)' | sed 's/=.*//; s/^/leaked: /' >> "${log}"`,
        'case "$*" in *"daemon status"*"--json"*) printf \'{"localDaemon":"running","listen":"127.0.0.1:6790","home":"%s"}\\n\' "$PASEO_HOME" ;; esac',
      ].join("\n"),
    );
    chmodSync(stub, 0o755);
    writeConfig(home, "127.0.0.1:6790");
  }
  const envFile = [
    `BOZEO_SRC='${SRC}'`,
    `BOZEO_REPO='${repo}'`,
    `BOZEO_HOME='${home}'`,
    "BOZEO_PORT='6790'",
    `BOZEO_PROTECT='|${path.join(dir, "existing")}|6767|'`,
    `. "${ENV_SH}"`,
  ].join("\n");
  writeFileSync(path.join(dir, "install.env"), `${envFile}\n`);
  const result = spawnSync("bash", ["-c", `. "${path.join(dir, "install.env")}"\n${script}`], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ANTHROPIC_API_KEY: "sk-sentinel-key",
      CLAUDE_CONFIG_DIR: "/installer/claude",
      CLAUDECODE: "1",
      GIT_EDITOR: "true",
      PASEO_AGENT_ID: "parent",
      ...extraEnv,
    },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
  rmSync(log, { force: true });
  return { code: result.status, out: `${result.stdout}${result.stderr}`, calls, home };
}

test("bozeo_cli refuses stop and restart wherever the options are", { skip: !IS_POSIX }, () => {
  const { dir, done } = scratch();
  try {
    for (const command of [
      "bozeo_cli --json daemon stop",
      "bozeo_cli daemon stop",
      "bozeo_cli daemon --json stop",
      "bozeo_cli daemon restart",
      "bozeo_cli restart",
      "bozeo_cli --home /x daemon status",
      "bozeo_cli daemon status --json stop",
      'bozeo_cli daemon stop --home "$BOZEO_HOME"',
      "bozeo_cli daemon status --home /some/other/home",
      "bozeo_cli reload --host 127.0.0.1:6767",
      "bozeo_cli reload --host=127.0.0.1:6767",
      'bozeo_cli daemon start --home "$BOZEO_HOME" --listen 127.0.0.1:6767',
    ]) {
      const { code, out, calls } = envShell(dir, command);
      assert.notEqual(code, 0, command);
      assert.match(out, /STOP:/, command);
      assert.equal(calls, "", `${command} reached the CLI: ${calls}`);
    }
  } finally {
    done();
  }
});

test(
  "bozeo_cli runs allowed commands with the session's Claude env cleared",
  { skip: !IS_POSIX },
  () => {
    const { dir, done } = scratch();
    try {
      const status = envShell(dir, 'bozeo_cli daemon status --home "$BOZEO_HOME/"');
      assert.equal(status.code, 0, status.out);
      assert.match(status.calls, /args: daemon status --home/);
      assert.doesNotMatch(status.calls, /leaked/);
      const reload = envShell(
        dir,
        'bozeo_cli reload --host "$BOZEO_HOST"; echo "cleared: $BOZEO_CLEARED"',
      );
      assert.equal(reload.code, 0, reload.out);
      assert.match(reload.calls, /args: reload --host 127\.0\.0\.1:6790/);
      assert.doesNotMatch(reload.calls, /leaked/);
      assert.doesNotMatch(reload.out, /sk-sentinel/);
      for (const name of [
        "ANTHROPIC_API_KEY",
        "CLAUDE_CONFIG_DIR",
        "CLAUDECODE",
        "GIT_EDITOR",
        "PASEO_AGENT_ID",
      ]) {
        assert.match(reload.out, new RegExp(`cleared: .*\\b${name}\\b`), name);
      }
      const restart = envShell(dir, "bozeo_restart_instance");
      assert.equal(restart.code, 0, restart.out);
      assert.match(restart.calls, /args: daemon restart --home .* --port 6790/);
      assert.doesNotMatch(restart.calls, /leaked/);
    } finally {
      done();
    }
  },
);

test("the env file defines nothing when the home is an existing one", { skip: !IS_POSIX }, () => {
  const { dir, done } = scratch();
  try {
    writeConfig(path.join(dir, "existing"), "127.0.0.1:6767");
    const { code, out } = envShell(dir, "type bozeo_cli", {});
    assert.equal(code, 0, out);
    const aliased = spawnSync(
      "bash",
      [
        "-c",
        `BOZEO_SRC='${SRC}' BOZEO_REPO='${SRC}' BOZEO_HOME='${path.join(dir, "existing")}/' BOZEO_PORT=6790 BOZEO_PROTECT='|${path.join(dir, "existing")}|'; . "${ENV_SH}"; type bozeo_cli`,
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME } },
    );
    assert.notEqual(aliased.status, 0);
    assert.match(`${aliased.stdout}${aliased.stderr}`, /STOP: BOZEO_HOME/);
    assert.deepEqual(readdirSync(path.join(dir, "existing")), ["config.json"]);
  } finally {
    done();
  }
});
