// node --test ops/public-web/server.test.mjs
// Starts server.mjs on an ephemeral port over temp roots, with no tunnel and no :80 redirect
// (BOZEO_PUBLIC_WEB_TUNNEL=0), and checks the /b/ shared-builds contract (docs/shared-builds.md)
// and that the web UI paths are unchanged. Raw request paths, so nothing normalizes `..` first.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const SERVER = path.join(import.meta.dirname, "server.mjs");
const HOUR = 60 * 60 * 1000;

// Tokens are 22 base64url characters, like the daemon's.
const APK = "ApkShareToken000000000";
const IPA = "IpaShareToken000000000";
const EXPIRED = "ExpiredToken0000000000";
const BAD_DATE = "BadDateToken0000000000";
const MISMATCH = "MismatchToken000000000";
const LINKED = "LinkedToken00000000000";
const UNKNOWN = "UnknownToken0000000000";

let root;
let server;
let port;

function writeShare(dir, token, files, record = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "share.json"),
    JSON.stringify({ token, expiresAt: new Date(Date.now() + HOUR).toISOString(), ...record }),
  );
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
}

function request(pathname, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => reject(new Error("server did not start")), 10_000);
    let buffered = "";
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      for (const line of buffered.split("\n")) {
        try {
          const entry = JSON.parse(line);
          // Port 0 would mean the server didn't say where it bound, and a request to port 0
          // goes to port 80: never let the test reach a live listener.
          if (entry.msg === "static web UI listening" && entry.port > 0) {
            clearTimeout(timer);
            resolve({ child, port: entry.port });
          }
        } catch {}
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}`));
    });
  });
}

before(async () => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "public-web-test-")));
  const ui = path.join(root, "ui");
  const shares = path.join(root, "shares");
  const outside = path.join(root, "outside");
  mkdirSync(ui, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(ui, "index.html"), "<html>web ui</html>");
  writeFileSync(path.join(ui, "app.js"), "console.log('ui')");
  writeFileSync(path.join(outside, "secret.apk"), "secret");

  writeShare(path.join(shares, APK), APK, {
    "app-debug.apk": "apk bytes",
    ".hidden.apk": "hidden",
    "notes.txt": "notes",
  });
  symlinkSync(path.join(outside, "secret.apk"), path.join(shares, APK, "evil.apk"));
  writeShare(path.join(shares, IPA), IPA, {
    "Fake.ipa": "ipa bytes",
    "manifest.plist": "<plist/>",
    "index.html": "<html>install</html>",
  });
  writeShare(path.join(shares, EXPIRED), EXPIRED, { "app-debug.apk": "old" }, {
    expiresAt: new Date(Date.now() - HOUR).toISOString(),
  });
  writeShare(path.join(shares, BAD_DATE), BAD_DATE, { "app-debug.apk": "x" }, { expiresAt: "soon" });
  writeShare(path.join(shares, MISMATCH), "SomeOtherToken00000000", { "app-debug.apk": "x" });
  writeShare(path.join(outside, "linked"), LINKED, { "app-debug.apk": "x" });
  symlinkSync(path.join(outside, "linked"), path.join(shares, LINKED));
  writeShare(path.join(shares, `.tmp-${UNKNOWN}`), UNKNOWN, { "app-debug.apk": "x" });

  ({ child: server, port } = await startServer({
    BOZEO_PUBLIC_WEB_PORT: "0",
    BOZEO_PUBLIC_WEB_ROOT: ui,
    BOZEO_PUBLIC_WEB_SHARES: shares,
    BOZEO_PUBLIC_WEB_TUNNEL: "0",
  }));
});

after(() => {
  server?.kill("SIGTERM");
  rmSync(root, { recursive: true, force: true });
});

test("serves a live APK as an Android package attachment, never cached", async () => {
  const res = await request(`/b/${APK}/app-debug.apk`);
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "application/vnd.android.package-archive");
  assert.equal(res.headers["content-disposition"], 'attachment; filename="app-debug.apk"');
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers["x-robots-tag"], "noindex");
  assert.equal(res.body.toString(), "apk bytes");
});

test("serves an IPA, its manifest and its install page under a locked-down CSP", async () => {
  const ipa = await request(`/b/${IPA}/Fake.ipa`);
  assert.equal(ipa.status, 200);
  assert.equal(ipa.headers["content-type"], "application/octet-stream");
  const manifest = await request(`/b/${IPA}/manifest.plist`);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers["content-type"], "application/xml");
  for (const pathname of [`/b/${IPA}/`, `/b/${IPA}`, `/b/${IPA}/index.html`]) {
    const page = await request(pathname);
    assert.equal(page.status, 200, pathname);
    assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(page.body.toString(), "<html>install</html>");
    assert.match(page.headers["content-security-policy"], /default-src 'none'/);
  }
});

test("HEAD answers with headers only; other methods are refused", async () => {
  const head = await request(`/b/${APK}/app-debug.apk`, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-length"], "9");
  assert.equal(head.body.length, 0);
  assert.equal((await request(`/b/${APK}/app-debug.apk`, "POST")).status, 405);
});

test("never serves what isn't a live share's build file", async () => {
  const notFound = [
    [`/b/${APK}/share.json`, "the record"],
    [`/b/${APK}/.hidden.apk`, "a dotfile"],
    [`/b/${APK}/notes.txt`, "an unknown type"],
    [`/b/${APK}/`, "a share with no install page"],
    [`/b/${APK}/missing.apk`, "a missing file"],
    [`/b/${EXPIRED}/app-debug.apk`, "an expired share"],
    [`/b/${BAD_DATE}/app-debug.apk`, "an unparseable expiry"],
    [`/b/${MISMATCH}/app-debug.apk`, "a record for another token"],
    [`/b/${UNKNOWN}/app-debug.apk`, "an unknown token"],
    [`/b/${APK.toLowerCase()}/app-debug.apk`, "a token in the wrong case"],
    [`/b/${LINKED}/app-debug.apk`, "a symlinked share directory"],
    [`/b/${APK}/evil.apk`, "a symlink out of the share"],
    [`/b/.tmp-${UNKNOWN}/app-debug.apk`, "a share still being written"],
    ["/b/short/app-debug.apk", "a short token"],
    ["/b", "the bare prefix"],
    ["/b/", "the prefix directory"],
  ];
  for (const [pathname, label] of notFound) {
    assert.equal((await request(pathname)).status, 404, `${label}: ${pathname}`);
  }
});

test("traversal out of a share is a 404", async () => {
  for (const pathname of [
    `/b/${APK}/../../outside/secret.apk`,
    `/b/${APK}/..%2F..%2Foutside%2Fsecret.apk`,
    `/b/${APK}/%2e%2e%2f%2e%2e%2foutside%2fsecret.apk`,
    "/b/../outside/secret.apk",
    `/b/${APK}/..`,
    `/b/${APK}/%00.apk`,
  ]) {
    assert.equal((await request(pathname)).status, 404, pathname);
  }
});

test("the web UI paths are unchanged", async () => {
  const index = await request("/");
  assert.equal(index.status, 200);
  assert.equal(index.body.toString(), "<html>web ui</html>");
  const route = await request("/h/server/workspace/1");
  assert.equal(route.body.toString(), "<html>web ui</html>");
  // Only /b and /b/... are shares; an app route that merely starts with b is still the UI.
  assert.equal((await request("/browse")).body.toString(), "<html>web ui</html>");
  const js = await request("/app.js");
  assert.equal(js.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal((await request("/missing.png")).status, 404);
  assert.equal((await request("/app.js", "POST")).status, 405);
});
