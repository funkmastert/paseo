import { describe, expect, it } from "vitest";
import { resolveBroadcastTargetSendPlan } from "./use-broadcast-pinned-composer";

describe("resolveBroadcastTargetSendPlan", () => {
  it("queues locally when send behavior is queue and the target is running", () => {
    const plan = resolveBroadcastTargetSendPlan({
      sendBehavior: "queue",
      isRunning: true,
      turnId: "turn-1",
    });
    expect(plan).toEqual({ queueLocally: true });
  });

  it("dispatches with steer when send behavior is queue and the target is idle", () => {
    const plan = resolveBroadcastTargetSendPlan({
      sendBehavior: "queue",
      isRunning: false,
      turnId: null,
    });
    expect(plan).toEqual({ queueLocally: false, behavior: "steer", turnId: undefined });
  });

  it("dispatches with steer and the active turnId when send behavior is steer", () => {
    const plan = resolveBroadcastTargetSendPlan({
      sendBehavior: "steer",
      isRunning: true,
      turnId: "turn-1",
    });
    expect(plan).toEqual({ queueLocally: false, behavior: "steer", turnId: "turn-1" });
  });

  it("dispatches with interrupt regardless of whether the target is running", () => {
    const plan = resolveBroadcastTargetSendPlan({
      sendBehavior: "interrupt",
      isRunning: true,
      turnId: "turn-1",
    });
    expect(plan).toEqual({ queueLocally: false, behavior: "interrupt" });
  });
});
