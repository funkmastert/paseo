#!/usr/bin/env node
// Answers one question: is there a Bozeo daemon at this address, and what do I
// type into "Add host"?
//
//   node scripts/check-remote-host.mjs 100.80.154.65
//   node scripts/check-remote-host.mjs bozeo.ngrok.app:443
//
// Serving HTML on `/` does not mean a daemon is there: the web UI is static
// assets, and a tunnel can serve them with nothing behind the WebSocket. Only a
// `/ws` upgrade proves a daemon. This checks that.

import net from "node:net";
import dns from "node:dns/promises";
import { createRequire } from "node:module";

const WebSocket = createRequire(import.meta.url)("ws");

const DEFAULT_PORT = 6767;
const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/check-remote-host.mjs <host[:port]>");
  process.exit(2);
}

const [host, portRaw] = target.replace(/^\w+:\/\//, "").split(":");
const port = Number(portRaw ?? DEFAULT_PORT);
const line = (label, value) => console.log(`  ${label.padEnd(22)} ${value}`);

console.log(`\nChecking ${host}:${port}\n`);

// 1. DNS
let addrs = [];
try {
  addrs = (await dns.lookup(host, { all: true })).map((a) => a.address);
  line("dns", addrs.join(", "));
} catch (e) {
  line("dns", `FAILED (${e.code ?? e.message})`);
  console.log("\nverdict  the hostname does not resolve. Check the address.\n");
  process.exit(1);
}

// 2. TCP
const tcpOpen = await new Promise((resolve) => {
  const s = net.connect({ host, port, timeout: 6000 });
  s.on("connect", () => (s.destroy(), resolve(true)));
  s.on("timeout", () => (s.destroy(), resolve(false)));
  s.on("error", () => resolve(false));
});
line("tcp", tcpOpen ? "open" : "CLOSED or filtered");
if (!tcpOpen) {
  console.log(`
verdict  nothing is listening on ${host}:${port}.

  The daemon may be running but bound to loopback, which accepts nothing from
  the network. On that machine:

    paseo daemon status --home ~/.paseo | grep -E 'Local Daemon|Listen'

  Listen 127.0.0.1:${port} is the loopback case. Set daemon.listen in
  ~/.paseo/config.json to the machine's tailnet address or 0.0.0.0:${port} and
  restart the daemon -- daemon.listen is read at startup, so reload will not
  apply it.
`);
  process.exit(1);
}

// 3. WebSocket upgrade — the only proof of a daemon
async function tryWs(scheme) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${scheme}://${host}:${port}/ws`, {
      handshakeTimeout: 10000,
      headers: { "ngrok-skip-browser-warning": "1" },
      rejectUnauthorized: false,
    });
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {}
      resolve(r);
    };
    ws.on("open", () => done({ ok: true }));
    ws.on("unexpected-response", (_rq, rs) => done({ ok: false, status: rs.statusCode }));
    ws.on("error", (e) => done({ ok: false, error: e.message }));
    setTimeout(() => done({ ok: false, error: "timeout" }), 10500);
  });
}

const plain = await tryWs("ws");
const tls = plain.ok ? { ok: false, skipped: true } : await tryWs("wss");

function describe(r) {
  if (r.ok) return "UPGRADED (daemon)";
  if (r.skipped) return "-";
  if (r.status) return `HTTP ${r.status}, no upgrade`;
  return r.error;
}
line("ws://  /ws", describe(plain));
line("wss:// /ws", describe(tls));

if (plain.ok || tls.ok) {
  const ssl = tls.ok;
  console.log(`
verdict  a Bozeo daemon is reachable here.

  Add host -> Direct connection:
    Host     ${host}
    Port     ${port}
    Use SSL  ${ssl ? "ON  (a TLS terminator is in front of the daemon)" : "off (no TLS terminator)"}
`);
  process.exit(0);
}

const servedHtml = plain.status === 200 || tls.status === 200;
console.log(`
verdict  something answers on ${host}:${port}, but it is NOT a daemon.
${
  servedHtml
    ? `
  It returned HTTP 200 instead of upgrading, which is what a static copy of the
  web UI does. The UI connects to location.origin + /ws, so a tunnel that
  serves the assets without forwarding the WebSocket produces a page that loads
  and never populates. Point the tunnel at the daemon's port, not at the assets.
`
    : `
  The port is open but the WebSocket handshake failed. If a TLS terminator is in
  front of the daemon, the client must use SSL; if there is none, it must not.
`
}  Adding this as a host will fail. Fix the address first, then re-run this check.
`);
process.exit(1);
