import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkConfigDirs, planMerge } from "./install-lib.mjs";

const SCRIPT = path.resolve("scripts", "install-merge-config.mjs");
const SECRET = "sk-sentinel-never-print";

const pool = {
  pluginsEnabled: true,
  agents: {
    providers: {
      "claude-leader": { extends: "claude", env: { CLAUDE_CONFIG_DIR: "/abs/leader" } },
    },
  },
  agentModelPolicy: { schemaVersion: 4, revision: "1", roles: [] },
};

function run(args) {
  try {
    return {
      code: 0,
      out: execFileSync("node", [SCRIPT, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (error) {
    return { code: error.status, out: `${error.stdout}${error.stderr}` };
  }
}

function scratch() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "install-merge-test-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("adds missing keys and keeps every existing one", () => {
  const config = {
    providers: { openai: { apiKey: SECRET } },
    agents: { resourceMonitor: { enabled: false } },
  };
  const { merged, added, conflicts } = planMerge(config, pool);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(added, ["pluginsEnabled", "agents.providers.claude-leader", "agentModelPolicy"]);
  assert.equal(merged.providers.openai.apiKey, SECRET);
  assert.deepEqual(merged.agents.resourceMonitor, { enabled: false });
});

test("an existing agentModelPolicy is never merged into or replaced", () => {
  const config = { agentModelPolicy: { schemaVersion: 4, revision: "mine", roles: [{ id: "x" }] } };
  const { merged, conflicts } = planMerge(config, pool);
  assert.deepEqual(conflicts, ["agentModelPolicy"]);
  assert.equal(merged.agentModelPolicy.revision, "mine");
});

test("an existing provider id with other settings is a conflict; other ids still add", () => {
  const config = { agents: { providers: { "claude-leader": { extends: "claude" } } } };
  const patch = {
    agents: { providers: { ...pool.agents.providers, "claude-worker-1": { extends: "claude" } } },
  };
  const { added, conflicts } = planMerge(config, patch);
  assert.deepEqual(conflicts, ["agents.providers.claude-leader"]);
  assert.deepEqual(added, ["agents.providers.claude-worker-1"]);
});

test("pluginsEnabled false is a conflict, not flipped", () => {
  assert.deepEqual(planMerge({ pluginsEnabled: false }, pool).conflicts, ["pluginsEnabled"]);
});

test("rejects relative, ~ and ~/.claude config dirs", () => {
  const patch = (dir) => ({ agents: { providers: { a: { env: { CLAUDE_CONFIG_DIR: dir } } } } });
  assert.equal(checkConfigDirs(patch("~/.claude-accounts/a"), "/home/u").length, 1);
  assert.equal(checkConfigDirs(patch("rel/a"), "/home/u").length, 1);
  assert.equal(checkConfigDirs(patch("/home/u/.claude"), "/home/u").length, 1);
  assert.equal(checkConfigDirs(patch("/home/u/.claude-accounts/a"), "/home/u").length, 0);
});

test("dry run writes nothing and never prints an existing value", () => {
  const { dir, done } = scratch();
  try {
    const config = path.join(dir, "config.json");
    const patchFile = path.join(dir, "patch.json");
    const original = `${JSON.stringify({ providers: { openai: { apiKey: SECRET } } })}\n`;
    writeFileSync(config, original, { mode: 0o600 });
    writeFileSync(patchFile, JSON.stringify(pool));
    const { code, out } = run(["--config", config, "--patch", patchFile]);
    assert.equal(code, 0);
    assert.match(out, /add {7}agentModelPolicy/);
    assert.doesNotMatch(out, new RegExp(SECRET));
    assert.equal(readFileSync(config, "utf8"), original);
    assert.deepEqual(readdirSync(dir).sort(), ["config.json", "patch.json"]);
  } finally {
    done();
  }
});

test("--write backs up, keeps the mode, and a rerun has nothing to add", () => {
  const { dir, done } = scratch();
  try {
    const config = path.join(dir, "config.json");
    const patchFile = path.join(dir, "patch.json");
    const original = `${JSON.stringify({ providers: { openai: { apiKey: SECRET } } })}\n`;
    writeFileSync(config, original, { mode: 0o600 });
    writeFileSync(patchFile, JSON.stringify(pool));
    const first = run(["--config", config, "--patch", patchFile, "--write"]);
    assert.equal(first.code, 0);
    assert.doesNotMatch(first.out, new RegExp(SECRET));
    const backups = readdirSync(dir).filter((name) => name.startsWith("config.json.bak-"));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(path.join(dir, backups[0]), "utf8"), original);
    assert.equal(statSync(config).mode & 0o777, 0o600);
    const written = JSON.parse(readFileSync(config, "utf8"));
    assert.equal(written.providers.openai.apiKey, SECRET);
    assert.equal(written.pluginsEnabled, true);
    const second = run(["--config", config, "--patch", patchFile, "--write"]);
    assert.equal(second.code, 0);
    assert.match(second.out, /nothing to add/);
  } finally {
    done();
  }
});

test("conflicts exit 3 and write nothing, even with --write", () => {
  const { dir, done } = scratch();
  try {
    const config = path.join(dir, "config.json");
    const patchFile = path.join(dir, "patch.json");
    const original = `${JSON.stringify({ agentModelPolicy: { revision: SECRET } })}\n`;
    writeFileSync(config, original);
    writeFileSync(patchFile, JSON.stringify(pool));
    const { code, out } = run(["--config", config, "--patch", patchFile, "--write"]);
    assert.equal(code, 3);
    assert.match(out, /conflict {2}agentModelPolicy/);
    assert.doesNotMatch(out, new RegExp(SECRET));
    assert.equal(readFileSync(config, "utf8"), original);
    assert.deepEqual(readdirSync(dir).sort(), ["config.json", "patch.json"]);
  } finally {
    done();
  }
});

/** Every 6-character slice of the secret: V8's parse errors quote about 10 characters. */
function assertNoSecretFragment(out) {
  for (let i = 0; i + 6 <= SECRET.length; i += 1) {
    assert.ok(!out.includes(SECRET.slice(i, i + 6)), `output leaks "${SECRET.slice(i, i + 6)}"`);
  }
}

test("invalid JSON in config.json is reported by line, without any of its content", () => {
  const { dir, done } = scratch();
  try {
    const config = path.join(dir, "config.json");
    const patchFile = path.join(dir, "patch.json");
    // The single quotes make V8's message quote the text around the key.
    const broken = `{\n  "version": 1,\n  "providers": { "openai": { "apiKey": '${SECRET}' } }\n}\n`;
    writeFileSync(config, broken);
    writeFileSync(patchFile, JSON.stringify(pool));
    const { code, out } = run(["--config", config, "--patch", patchFile, "--write"]);
    assert.equal(code, 1);
    assert.match(out, /is not valid JSON at line 3/);
    assertNoSecretFragment(out);
    assert.equal(readFileSync(config, "utf8"), broken);
    assert.deepEqual(readdirSync(dir).sort(), ["config.json", "patch.json"]);
  } finally {
    done();
  }
});

test("a symlinked config.json is written through to its target and stays a link", () => {
  const { dir, done } = scratch();
  try {
    const dotfiles = path.join(dir, "dotfiles");
    const home = path.join(dir, "home");
    mkdirSync(dotfiles);
    mkdirSync(home);
    const target = path.join(dotfiles, "paseo-config.json");
    const link = path.join(home, "config.json");
    const patchFile = path.join(dir, "patch.json");
    const original = `${JSON.stringify({ providers: { openai: { apiKey: SECRET } } })}\n`;
    writeFileSync(target, original, { mode: 0o600 });
    symlinkSync(target, link);
    writeFileSync(patchFile, JSON.stringify(pool));
    const { code, out } = run(["--config", link, "--patch", patchFile, "--write"]);
    assert.equal(code, 0, out);
    assert.match(out, /link {6}.* points here; the link is kept/);
    assertNoSecretFragment(out);
    assert.ok(lstatSync(link).isSymbolicLink(), "config.json is still a symlink");
    assert.equal(readlinkSync(link), target);
    const written = JSON.parse(readFileSync(target, "utf8"));
    assert.equal(written.pluginsEnabled, true);
    assert.equal(written.providers.openai.apiKey, SECRET);
    assert.equal(statSync(target).mode & 0o777, 0o600);
    const backups = readdirSync(dotfiles).filter((name) =>
      name.startsWith("paseo-config.json.bak-"),
    );
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(path.join(dotfiles, backups[0]), "utf8"), original);
    assert.deepEqual(readdirSync(home), ["config.json"]);
  } finally {
    done();
  }
});

test("a dangling config.json link is refused, not replaced", () => {
  const { dir, done } = scratch();
  try {
    const link = path.join(dir, "config.json");
    const patchFile = path.join(dir, "patch.json");
    symlinkSync(path.join(dir, "missing.json"), link);
    writeFileSync(patchFile, JSON.stringify(pool));
    const { code, out } = run(["--config", link, "--patch", patchFile, "--write"]);
    assert.equal(code, 1);
    assert.match(out, /symlink whose target cannot be resolved/);
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.deepEqual(readdirSync(dir).sort(), ["config.json", "patch.json"]);
  } finally {
    done();
  }
});

test("a read-only config.json is refused, not replaced", { skip: process.getuid?.() === 0 }, () => {
  const { dir, done } = scratch();
  try {
    const config = path.join(dir, "config.json");
    const patchFile = path.join(dir, "patch.json");
    const original = `${JSON.stringify({ version: 1 })}\n`;
    writeFileSync(config, original, { mode: 0o400 });
    writeFileSync(patchFile, JSON.stringify(pool));
    const { code, out } = run(["--config", config, "--patch", patchFile, "--write"]);
    assert.equal(code, 1);
    assert.match(out, /is not writable/);
    assert.equal(readFileSync(config, "utf8"), original);
    assert.equal(statSync(config).mode & 0o777, 0o400);
    assert.deepEqual(readdirSync(dir).sort(), ["config.json", "patch.json"]);
  } finally {
    chmodSync(path.join(dir, "config.json"), 0o600);
    done();
  }
});

test("run through a symlinked path, the script still does its work", () => {
  const { dir, done } = scratch();
  try {
    const linkedScript = path.join(dir, "merge.mjs");
    symlinkSync(SCRIPT, linkedScript);
    const config = path.join(dir, "config.json");
    const patchFile = path.join(dir, "patch.json");
    writeFileSync(config, `${JSON.stringify({ version: 1 })}\n`);
    writeFileSync(patchFile, JSON.stringify(pool));
    const out = execFileSync("node", [linkedScript, "--config", config, "--patch", patchFile], {
      encoding: "utf8",
    });
    assert.match(out, /add {7}agentModelPolicy/);
    assert.match(out, /result {4}dry run/);
  } finally {
    done();
  }
});
