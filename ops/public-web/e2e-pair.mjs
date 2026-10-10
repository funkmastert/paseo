// End-to-end check of https://bozeo.ngrok.app: load the app at phone size, pair through the relay
// with a fresh offer, and confirm it reaches the daemon. The browser context is throwaway, so no
// pairing survives the run.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire("/Users/tylerthackray/paseo-worktrees/bozeo/package.json");
const { chromium, devices } = require("playwright");

const OUT = "/Users/tylerthackray/bozeo-ops/public-web";
const offerUrl = JSON.parse(readFileSync("/Users/tylerthackray/bozeo-ops/pair.json", "utf8")).url;
const fragment = offerUrl.slice(offerUrl.indexOf("#"));

const browser = await chromium.launch();
const context = await browser.newContext({ ...devices["iPhone 14"] });
const page = await context.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
page.on("pageerror", (e) => errors.push("pageerror: " + String(e).slice(0, 200)));

await page.goto("https://bozeo.ngrok.app/", { waitUntil: "networkidle", timeout: 60_000 });
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/e2e-1-first-visit.png` });
console.log("first visit:", page.url().replace(/#.*/, ""), "|", (await page.innerText("body")).replace(/\s+/g, " ").slice(0, 200));

// A fragment-only change is an in-page navigation; the app reads the offer on a fresh load, the
// way tapping the link on a phone opens it.
await page.close();
const paired = await context.newPage();
paired.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
await paired.goto("https://bozeo.ngrok.app/" + fragment, { waitUntil: "networkidle", timeout: 60_000 });
await paired.waitForTimeout(25_000);
await paired.screenshot({ path: `${OUT}/e2e-2-after-pair.png` });
console.log("after pair:", paired.url().replace(/#.*/, ""), "|", (await paired.innerText("body")).replace(/\s+/g, " ").slice(0, 500));

// The fleet should be visible through the relay: open the sidebar and look for known work.
await paired.mouse.click(24, 35);
await paired.waitForTimeout(6000);
await paired.screenshot({ path: `${OUT}/e2e-3-sidebar.png` });
const sidebar = (await paired.innerText("body")).replace(/\s+/g, " ");
const known = ["paseo", "DungeonCoder", "health-score-v2", "W1.2", "Restart recovery", "bozeo"];
console.log("sidebar:", sidebar.slice(0, 500));
console.log("known names seen:", known.filter((k) => sidebar.includes(k)).join(", ") || "none");

const stored = await paired.evaluate(() => Object.keys(localStorage));
console.log("storage keys:", stored.join(", ") || "none");
console.log("console errors:", errors.length ? "\n  " + [...new Set(errors)].slice(0, 8).join("\n  ") : "none");
await browser.close();
