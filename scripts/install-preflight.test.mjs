import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const SCRIPT = path.resolve("scripts", "install-preflight.mjs");
const SECRET = "sk-sentinel-never-print";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function preflight(home, args) {
  const result = spawnSync("node", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      HOME: home,
      USERPROFILE: home,
      PATH: [path.dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(
        path.delimiter,
      ),
      SYSTEMROOT: process.env.SYSTEMROOT ?? "",
      ANTHROPIC_API_KEY: SECRET,
      CLAUDE_CONFIG_DIR: "/installer/claude",
    },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

test("a broken config.json is reported by line, and no fragment of a secret is printed", async () => {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "install-preflight-test-")));
  try {
    const paseoHome = path.join(home, ".paseo");
    mkdirSync(paseoHome);
    const broken = `{\n  "version": 1,\n  "providers": { "openai": { "apiKey": '${SECRET}' } }\n}\n`;
    writeFileSync(path.join(paseoHome, "config.json"), broken);
    const { code, out } = preflight(home, ["--default-port", String(await freePort())]);
    assert.equal(code, 0, out);
    assert.match(out, /config\.json: not valid JSON at line 3 \(content not shown\)/);
    for (let i = 0; i + 6 <= SECRET.length; i += 1) {
      assert.ok(!out.includes(SECRET.slice(i, i + 6)), `output leaks "${SECRET.slice(i, i + 6)}"`);
    }
    assert.match(
      out,
      /kept out of the new daemon \(names only\): ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR/,
    );
    assert.equal(readFileSync(path.join(paseoHome, "config.json"), "utf8"), broken);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
