import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { NotifyLedgerEntry } from "@getpaseo/protocol/notify-policy/types";

import { PushLedger } from "../push/ledger.js";
import type { PushDelivery, PushDeliveryResult, PushPayload } from "../push/push-service.js";
import { NotifyPolicy, type NotifyTransport } from "./notify-policy.js";
import { NotifyPolicySettingsStore } from "./settings.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return logger as unknown as pino.Logger;
}

interface Sent {
  payload: PushPayload;
  delivery: PushDelivery;
}

function titlesOf(sent: Sent[]): string[] {
  return sent.map(titleOf);
}
function titleOf(sent: Sent): string {
  return sent.payload.title;
}
function deliveriesOf(sent: Sent[]): PushDelivery[] {
  return sent.map(deliveryOf);
}
function deliveryOf(sent: Sent): PushDelivery {
  return sent.delivery;
}
function titlesOfEntries(entries: NotifyLedgerEntry[]): string[] {
  return entries.map(entryTitle).toSorted();
}
function entryTitle(entry: NotifyLedgerEntry): string {
  return entry.title;
}

class FakeTransport implements NotifyTransport {
  tokens = ["ExponentPushToken[phone]"];
  sent: Sent[] = [];
  failWith: string | null = null;
  nextTicket = 1;

  activeTokens(): string[] {
    return this.tokens;
  }

  async deliver(
    tokens: string[],
    push: PushPayload,
    delivery: PushDelivery,
  ): Promise<PushDeliveryResult[]> {
    this.sent.push({ payload: push, delivery });
    if (this.failWith) {
      return tokens.map((token) => ({ token, ticketId: null, error: this.failWith }));
    }
    return tokens.map((token) => ({ token, ticketId: `ticket-${this.nextTicket++}`, error: null }));
  }
}

function payload(title: string, data: Record<string, unknown> = {}): PushPayload {
  return { title, body: `${title} body`, data: { serverId: "server-1", ...data } };
}

describe("NotifyPolicy", () => {
  let home: string;
  let now: number;
  let transport: FakeTransport;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "paseo-notify-policy-"));
    now = Date.parse("2026-09-23T12:00:00.000Z");
    transport = new FakeTransport();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function create(): {
    policy: NotifyPolicy;
    ledger: PushLedger;
    settings: NotifyPolicySettingsStore;
  } {
    const logger = createLogger();
    const ledger = new PushLedger(logger, path.join(home, "push-ledger.json"), () => now);
    const settings = new NotifyPolicySettingsStore(logger, path.join(home, "notify-policy.json"));
    const policy = new NotifyPolicy({ logger, ledger, settings, transport, now: () => now });
    return { policy, ledger, settings };
  }

  describe("levels", () => {
    test("an alert is pushed immediately with a sound", async () => {
      const { policy } = create();
      await policy.submit(payload("Agent finished"), { level: "alert" });
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]?.delivery).toEqual({ quiet: false });
    });

    test("an urgent push asks for time-sensitive delivery", async () => {
      const { policy } = create();
      await policy.submit(payload("Account nearly exhausted"), { level: "urgent" });
      expect(transport.sent[0]?.delivery).toEqual({ quiet: false, timeSensitive: true });
    });

    test("a notice is held instead of pushed", async () => {
      const { policy } = create();
      await policy.submit(payload("Agent is burning tokens fast"), { level: "notice" });
      expect(transport.sent).toHaveLength(0);
      expect(policy.getStatus().heldCount).toBe(1);
    });

    test("a record never leaves the ledger", async () => {
      const { policy } = create();
      await policy.submit(payload("Reclaimed disk space"), { level: "record" });
      await policy.updateSettings({ digestIntervalMinutes: 1 });
      now += HOUR;
      await policy.tick();
      expect(transport.sent).toHaveLength(0);
      expect(policy.listLedger()).toMatchObject([{ outcome: "log", state: "recorded" }]);
    });

    test("a push with no level is a notice, and the ledger says it was not declared", async () => {
      const { policy } = create();
      await policy.submit(payload("Something new"));
      expect(transport.sent).toHaveLength(0);
      expect(policy.listLedger()).toMatchObject([
        { level: "notice", levelDeclared: false, state: "held" },
      ]);
    });

    test("the interrupt dial can promote notices to interrupts", async () => {
      const { policy } = create();
      await policy.updateSettings({ minInterruptLevel: "notice" });
      await policy.submit(payload("Agent is burning tokens fast"), { level: "notice" });
      expect(transport.sent).toHaveLength(1);
    });

    test("the post dial can silence a level entirely", async () => {
      const { policy } = create();
      await policy.updateSettings({ minPostLevel: "alert" });
      await policy.submit(payload("Agent is burning tokens fast"), { level: "notice" });
      await policy.submit(payload("Agent finished"), { level: "alert" });
      expect(titlesOf(transport.sent)).toEqual(["Agent finished"]);
      expect(policy.getStatus().heldCount).toBe(0);
    });
  });

  describe("digests", () => {
    test("held notices go out as one quiet digest once the interval passes", async () => {
      const { policy } = create();
      await policy.submit(payload("Agent is burning tokens fast", { agentId: "a" }), {
        level: "notice",
      });
      now += 10 * MINUTE;
      await policy.submit(payload("Agent is burning tokens fast", { agentId: "b" }), {
        level: "notice",
      });
      await policy.submit(payload("Worktree needs attention"), { level: "notice" });

      now += 19 * MINUTE;
      await policy.tick();
      expect(transport.sent).toHaveLength(0);

      now += 2 * MINUTE;
      await policy.tick();
      expect(transport.sent).toHaveLength(1);
      const digest = transport.sent[0];
      expect(digest?.delivery).toEqual({ quiet: true });
      expect(digest?.payload.title).toBe("3 notices from Paseo");
      expect(digest?.payload.body).toBe(
        "Agent is burning tokens fast (x2)\nWorktree needs attention",
      );
      expect(digest?.payload.data).toMatchObject({ reason: "notify_digest", count: 3 });
      expect(policy.getStatus().heldCount).toBe(0);
    });

    test("a digest of one is that notification, sent quietly", async () => {
      const { policy } = create();
      await policy.submit(payload("Agent moved to a new account", { agentId: "a" }), {
        level: "notice",
      });
      now += HOUR;
      await policy.tick();
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]?.payload.title).toBe("Agent moved to a new account");
      expect(transport.sent[0]?.payload.data).toMatchObject({ agentId: "a" });
      expect(transport.sent[0]?.delivery).toEqual({ quiet: true });
    });

    test("each notice is delivered exactly once", async () => {
      const { policy } = create();
      await policy.submit(payload("One"), { level: "notice" });
      now += HOUR;
      await policy.tick();
      await policy.tick();
      now += HOUR;
      await policy.tick();
      expect(transport.sent).toHaveLength(1);
    });

    test("held notices survive a daemon restart and are sent by the new process", async () => {
      const first = create();
      await first.policy.submit(payload("One"), { level: "notice" });
      first.policy.stop();

      now += HOUR;
      const second = create();
      expect(second.policy.getStatus().heldCount).toBe(1);
      await second.policy.start();
      expect(transport.sent).toHaveLength(1);
      expect(second.policy.getStatus().heldCount).toBe(0);
    });
  });

  describe("availability", () => {
    test("focus quiets an alert but not an urgent push", async () => {
      const { policy } = create();
      await policy.updateSettings({ availability: { mode: "focus" } });
      await policy.submit(payload("Agent finished"), { level: "alert" });
      await policy.submit(payload("Disk space critically low"), { level: "urgent" });
      expect(deliveriesOf(transport.sent)).toEqual([
        { quiet: true },
        { quiet: false, timeSensitive: true },
      ]);
    });

    test("focus stretches the digest to two hours", async () => {
      const { policy } = create();
      await policy.updateSettings({ availability: { mode: "focus" } });
      await policy.submit(payload("One"), { level: "notice" });
      now += HOUR + 50 * MINUTE;
      await policy.tick();
      expect(transport.sent).toHaveLength(0);
      now += 11 * MINUTE;
      await policy.tick();
      expect(transport.sent).toHaveLength(1);
    });

    test("away still interrupts for alerts but holds notices", async () => {
      const { policy } = create();
      await policy.updateSettings({ availability: { mode: "away" } });
      await policy.submit(payload("Agent finished"), { level: "alert" });
      await policy.submit(payload("One"), { level: "notice" });
      now += 4 * HOUR;
      await policy.tick();
      expect(deliveriesOf(transport.sent)).toEqual([{ quiet: false }]);
    });

    test("coming back from away sends what waited, once", async () => {
      const { policy } = create();
      await policy.updateSettings({ availability: { mode: "away" } });
      await policy.submit(payload("One"), { level: "notice" });
      now += 3 * HOUR;
      await policy.tick();
      expect(transport.sent).toHaveLength(0);

      await policy.updateSettings({ availability: { mode: "available" } });
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]?.delivery.quiet).toBe(true);
    });

    test("coming back from away sends the digest at once, without waiting out the interval", async () => {
      const { policy } = create();
      await policy.updateSettings({ availability: { mode: "away" } });
      await policy.submit(payload("One"), { level: "notice" });
      now += 5 * MINUTE;
      await policy.updateSettings({ availability: { mode: "available" } });
      expect(transport.sent).toHaveLength(1);
    });

    test("off quiets even urgent, and delivery is never dropped", async () => {
      const { policy } = create();
      await policy.updateSettings({ availability: { mode: "off" } });
      await policy.submit(payload("Disk space critically low"), { level: "urgent" });
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]?.delivery).toEqual({ quiet: true });
    });

    test("a mode with an end time reverts by itself and sends the digest", async () => {
      const { policy } = create();
      const until = new Date(now + 2 * HOUR).toISOString();
      await policy.updateSettings({ availability: { mode: "away", until } });
      await policy.submit(payload("One"), { level: "notice" });
      expect(policy.getStatus().effectiveAvailability.mode).toBe("away");

      now += 2 * HOUR + MINUTE;
      expect(policy.getStatus().effectiveAvailability.mode).toBe("available");
      await policy.tick();
      expect(transport.sent).toHaveLength(1);
    });
  });

  describe("repeats", () => {
    test("the same situation inside the cooldown is counted, not resent", async () => {
      const { policy } = create();
      const meta = { level: "urgent", dedupeKey: "account-pressure:claude:5h" } as const;
      await policy.submit(payload("Account usage is nearly exhausted"), meta);
      now += 5 * MINUTE;
      await policy.submit(payload("Account usage is nearly exhausted"), meta);
      now += 5 * MINUTE;
      await policy.submit(payload("Account usage is nearly exhausted"), meta);
      expect(transport.sent).toHaveLength(1);
      expect(policy.listLedger()).toMatchObject([{ repeatCount: 2 }]);
    });

    test("it is announced again once the cooldown has passed", async () => {
      const { policy } = create();
      const meta = { level: "urgent", dedupeKey: "account-pressure:claude:5h" } as const;
      await policy.submit(payload("Account usage is nearly exhausted"), meta);
      now += 61 * MINUTE;
      await policy.submit(payload("Account usage is nearly exhausted"), meta);
      expect(transport.sent).toHaveLength(2);
    });

    test("a repeat that is more urgent than the first still goes out", async () => {
      const { policy } = create();
      await policy.submit(payload("Agent is burning tokens fast"), {
        level: "notice",
        dedupeKey: "same-situation",
      });
      await policy.submit(payload("Agent paused"), { level: "alert", dedupeKey: "same-situation" });
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]?.payload.title).toBe("Agent paused");
    });

    test("the cooldown survives a daemon restart", async () => {
      const meta = { level: "alert", dedupeKey: "account-cap:claude" } as const;
      const first = create();
      await first.policy.submit(payload("Account capped"), meta);
      first.policy.stop();

      now += 5 * MINUTE;
      const second = create();
      await second.policy.start();
      await second.policy.submit(payload("Account capped"), meta);
      expect(transport.sent).toHaveLength(1);
    });

    test("notifications without a key are never folded together", async () => {
      const { policy } = create();
      await policy.submit(payload("Agent finished"), { level: "alert" });
      await policy.submit(payload("Agent finished"), { level: "alert" });
      expect(transport.sent).toHaveLength(2);
    });
  });

  describe("the ledger", () => {
    test("a delivered push is sent until its receipt comes back", async () => {
      const { policy } = create();
      await policy.submit(payload("Agent finished"), { level: "alert" });
      expect(policy.listLedger()).toMatchObject([{ outcome: "interrupt", state: "sent" }]);
      expect(policy.getStatus().unreachedCount).toBe(0);
    });

    test("a push the provider refuses is unreached", async () => {
      const { policy } = create();
      transport.failWith = "MessageRateExceeded";
      await policy.submit(payload("Agent finished"), { level: "alert" });
      expect(policy.getStatus().unreachedCount).toBe(1);
      expect(policy.listLedger({ unreachedOnly: true })).toMatchObject([
        { state: "failed", error: "MessageRateExceeded" },
      ]);
    });

    test("a push with no registered phone is unreached, and says why", async () => {
      const { policy } = create();
      transport.tokens = [];
      await policy.submit(payload("Agent finished"), { level: "alert" });
      expect(policy.listLedger({ unreachedOnly: true })).toMatchObject([
        { state: "no-device", error: "no registered device" },
      ]);
    });

    test("a notice inside a digest that failed is unreached too", async () => {
      const { policy } = create();
      transport.failWith = "InvalidCredentials";
      await policy.submit(payload("One"), { level: "notice" });
      await policy.submit(payload("Two"), { level: "notice" });
      now += HOUR;
      await policy.tick();
      const unreached = policy.listLedger({ unreachedOnly: true });
      expect(titlesOfEntries(unreached)).toEqual(["2 notices from Paseo", "One", "Two"]);
    });

    test("a record is not unreached just because nothing was sent", async () => {
      const { policy } = create();
      transport.tokens = [];
      await policy.submit(payload("Reclaimed disk space"), { level: "record" });
      expect(policy.getStatus().unreachedCount).toBe(0);
    });

    test("a push interrupted by a restart is finished, or retired if it went stale", async () => {
      const first = create();
      // Simulate a crash between the ledger write and the provider call.
      await first.policy.submit(payload("Fresh"), { level: "alert" });
      const fresh = first.ledger.list()[0];
      expect(fresh).toBeDefined();
      first.ledger.append({ ...fresh!, id: "fresh-unsent", state: "held", tickets: [] });
      first.ledger.append({
        ...fresh!,
        id: "stale-unsent",
        at: new Date(now - HOUR).toISOString(),
        state: "held",
        tickets: [],
      });
      transport.sent = [];

      const second = create();
      await second.policy.start();
      expect(transport.sent).toHaveLength(1);
      expect(second.ledger.get("fresh-unsent")?.state).toBe("sent");
      expect(second.ledger.get("stale-unsent")).toMatchObject({
        state: "failed",
        error: "not sent: the daemon restarted first",
      });
    });
  });

  describe("settings", () => {
    test("the defaults are quieter than before the policy existed", () => {
      const { policy } = create();
      expect(policy.getStatus().settings).toEqual({
        minPostLevel: "notice",
        minInterruptLevel: "alert",
        digestIntervalMinutes: 30,
        availability: { mode: "available", until: null },
      });
    });

    test("settings persist across a restart", async () => {
      const first = create();
      await first.policy.updateSettings({ minInterruptLevel: "urgent" });
      const second = create();
      expect(second.policy.getStatus().settings.minInterruptLevel).toBe("urgent");
    });
  });
});
