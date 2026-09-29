// Bozeo public web. Serves the fork's static web UI for https://bozeo.ngrok.app and keeps the
// ngrok tunnel to it running. Static files only: nothing here can reach the daemon. The app
// talks to the daemon through the E2E relay once the browser is paired with an offer link.
//
//   127.0.0.1:6780  static web UI (tunnel target)
//   *:80            308 to https, so Tyler's own `ngrok http 80 --url http://bozeo.ngrok.app` works
//
// Publish a new build with ./publish.sh; this server picks it up without a restart.
import { spawn } from "node:child_process";
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const PUBLIC_URL = "https://bozeo.ngrok.app";
const STATIC_PORT = 6780;
const ROOT = path.join(os.homedir(), ".paseo", "public-web-ui");
const NGROK = process.env.NGROK_BIN ?? "/opt/homebrew/bin/ngrok";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  // Pairing offers live in the URL fragment; never let a page leak its URL to another origin.
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
};

function log(msg, extra = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The file for a request path, or null. App routes (no extension) fall back to index.html. */
function resolveFile(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  let root;
  try {
    root = realpathSync(ROOT);
  } catch {
    return null;
  }
  const target = path.resolve(root, "." + path.posix.normalize("/" + decoded));
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  if (isFile(target)) return target;
  if (path.extname(target) === "" || decoded.endsWith("/")) {
    const index = path.join(root, "index.html");
    return isFile(index) ? index : null;
  }
  return null;
}

function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD", ...SECURITY_HEADERS }).end();
    return;
  }
  const { pathname } = new URL(req.url ?? "/", "http://x");
  const file = resolveFile(pathname);
  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain", ...SECURITY_HEADERS }).end("Not found");
    return;
  }
  const ext = path.extname(file);
  const accept = String(req.headers["accept-encoding"] ?? "");
  let body = file;
  let encoding;
  if (/\bbr\b/.test(accept) && isFile(file + ".br")) [body, encoding] = [file + ".br", "br"];
  else if (/\bgzip\b/.test(accept) && isFile(file + ".gz")) [body, encoding] = [file + ".gz", "gzip"];

  const isIndex = path.basename(file) === "index.html";
  const immutable = pathname.startsWith("/_expo/static/");
  const headers = {
    "Content-Type": TYPES[ext] ?? "application/octet-stream",
    "Content-Length": statSync(body).size,
    "Cache-Control": isIndex ? "no-cache" : immutable ? "public, max-age=31536000, immutable" : "public, max-age=3600",
    Vary: "Accept-Encoding",
    ...SECURITY_HEADERS,
  };
  if (encoding) headers["Content-Encoding"] = encoding;
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  createReadStream(body).on("error", () => res.destroy()).pipe(res);
}

function redirectToHttps(req, res) {
  const { pathname, search } = new URL(req.url ?? "/", "http://x");
  res.writeHead(308, { Location: PUBLIC_URL + pathname + search, ...SECURITY_HEADERS }).end();
}

function listen(server, port, host, label, onListening = () => {}) {
  server.on("error", (err) => log(`${label} not listening`, { host, port, code: err.code }));
  server.listen(port, host, () => {
    log(`${label} listening`, { host, port });
    onListening();
  });
}

// The tunnel publishes whatever answers on STATIC_PORT, so it starts only once this process owns
// the port. If the bind fails, exit non-zero and let launchd retry (ThrottleInterval) rather than
// run a tunnel to a port something else holds.
const staticServer = http.createServer(serveStatic);
staticServer.once("error", (err) => {
  log("static web UI can't bind; exiting so launchd retries", { port: STATIC_PORT, code: err.code });
  process.exit(1);
});
listen(staticServer, STATIC_PORT, "127.0.0.1", "static web UI", startTunnel);
// macOS lets an unprivileged process bind a port below 1024 only on the wildcard address. The
// listener only ever answers with a redirect, so being reachable on the LAN exposes nothing, and
// the dual-stack wildcard catches `ngrok http 80` dialling localhost as either family.
listen(http.createServer(redirectToHttps), 80, "::", "https redirect");

// The tunnel. No endpoint pooling: with pooling, anyone holding the authtoken could join
// bozeo.ngrok.app and serve a share of its requests. A leftover agent from an earlier run makes
// this one fail with "endpoint already online" instead; the exit handler retries with backoff.
let child = null;
let backoffMs = 2000;
let stopping = false;
function startTunnel() {
  if (!existsSync(NGROK)) {
    log("ngrok binary missing; retrying", { NGROK });
    setTimeout(startTunnel, 60_000);
    return;
  }
  const startedAt = Date.now();
  child = spawn(
    NGROK,
    [
      "http",
      `127.0.0.1:${STATIC_PORT}`,
      "--url",
      PUBLIC_URL,
      "--inspect=false",
      "--log",
      "stdout",
      "--log-format",
      "json",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const relay = (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j.lvl === "eror" || j.lvl === "crit" || j.msg === "started tunnel" || j.err) {
          log("ngrok", { lvl: j.lvl, msg: j.msg, err: j.err, url: j.url });
        }
      } catch {
        log("ngrok", { line: line.slice(0, 300) });
      }
    }
  };
  child.stdout.on("data", relay);
  child.stderr.on("data", relay);
  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) return;
    if (Date.now() - startedAt > 60_000) backoffMs = 2000;
    log("ngrok exited; restarting", { code, signal, inMs: backoffMs });
    setTimeout(startTunnel, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 60_000);
  });
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    stopping = true;
    child?.kill("SIGTERM");
    setTimeout(() => process.exit(0), 500);
  });
}
