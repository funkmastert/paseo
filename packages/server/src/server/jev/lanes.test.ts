import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { JevLaneLimits } from "./lanes.js";
import { JevCircuit, JevLanes } from "./lanes.js";

function settledFlag<T>(promise: Promise<T>): { get settled(): boolean } {
  const flag = { settled: false };
  void track();
  return flag;

  async function track(): Promise<void> {
    try {
      await promise;
    } catch {
      // Only settlement is tracked here; the value or rejection reason is asserted separately.
    } finally {
      flag.settled = true;
    }
  }
}

describe("JevCircuit", () => {
  test("starts closed", () => {
    const circuit = new JevCircuit();
    expect(circuit.state(0)).toBe("closed");
    expect(circuit.tryPass(0)).toBe(true);
  });

  test("opens after 5 consecutive failures", () => {
    const circuit = new JevCircuit();
    for (let i = 0; i < 4; i++) circuit.recordFailure(0);
    expect(circuit.state(0)).toBe("closed");
    circuit.recordFailure(0);
    expect(circuit.state(0)).toBe("open");
    expect(circuit.tryPass(0)).toBe(false);
  });

  test("a success in between resets the failure count", () => {
    const circuit = new JevCircuit();
    for (let i = 0; i < 4; i++) circuit.recordFailure(0);
    circuit.recordSuccess();
    for (let i = 0; i < 4; i++) circuit.recordFailure(0);
    expect(circuit.state(0)).toBe("closed");
  });

  test("goes half-open after openMs, lets exactly one probe through, and success closes it", () => {
    const circuit = new JevCircuit({ openMs: 60_000 });
    for (let i = 0; i < 5; i++) circuit.recordFailure(0);
    expect(circuit.state(59_999)).toBe("open");
    expect(circuit.state(60_000)).toBe("half-open");

    expect(circuit.tryPass(60_000)).toBe(true);
    expect(circuit.tryPass(60_000)).toBe(false);

    circuit.recordSuccess();
    expect(circuit.state(60_000)).toBe("closed");
    expect(circuit.tryPass(60_000)).toBe(true);
  });

  test("a failed probe reopens the circuit for another openMs", () => {
    const circuit = new JevCircuit({ openMs: 60_000 });
    for (let i = 0; i < 5; i++) circuit.recordFailure(0);
    expect(circuit.tryPass(60_000)).toBe(true);
    circuit.recordFailure(60_000);
    expect(circuit.state(60_000)).toBe("open");
    expect(circuit.state(119_999)).toBe("open");
    expect(circuit.state(120_000)).toBe("half-open");
  });
});

describe("JevLanes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const limits: JevLaneLimits = { control: 4, agentTools: 1, perGroup: 2, requestsPerSecond: 10 };

  test("a full agentTools lane leaves control acquisitions immediate", async () => {
    const lanes = new JevLanes();

    const held = await lanes.acquireSlot("agentTools", { deadlineAt: 100_000, limits });
    expect(held.ok).toBe(true);

    const controlResult = await lanes.acquireSlot("control", { deadlineAt: 100_000, limits });
    expect(controlResult.ok).toBe(true);
  });

  test("per-group limit 2 with lane limit 4 lets two groups run 2 each", async () => {
    const lanes = new JevLanes();
    const groupLimits: JevLaneLimits = {
      control: 4,
      agentTools: 4,
      perGroup: 2,
      requestsPerSecond: 10,
    };

    const a1 = await lanes.acquireSlot("agentTools", {
      deadlineAt: 100_000,
      group: "a",
      limits: groupLimits,
    });
    const a2 = await lanes.acquireSlot("agentTools", {
      deadlineAt: 100_000,
      group: "a",
      limits: groupLimits,
    });
    expect(a1.ok).toBe(true);
    expect(a2.ok).toBe(true);

    const a3Promise = lanes.acquireSlot("agentTools", {
      deadlineAt: 100_000,
      group: "a",
      limits: groupLimits,
    });
    const a3Flag = settledFlag(a3Promise);
    await Promise.resolve();
    expect(a3Flag.settled).toBe(false);

    const b1 = await lanes.acquireSlot("agentTools", {
      deadlineAt: 100_000,
      group: "b",
      limits: groupLimits,
    });
    const b2 = await lanes.acquireSlot("agentTools", {
      deadlineAt: 100_000,
      group: "b",
      limits: groupLimits,
    });
    expect(b1.ok).toBe(true);
    expect(b2.ok).toBe(true);

    if (a1.ok) a1.release();
    const a3 = await a3Promise;
    expect(a3.ok).toBe(true);
  });

  test("a deadline passing in the queue answers saturated and never touches the circuit", async () => {
    const lanes = new JevLanes();
    const tightLimits: JevLaneLimits = {
      control: 1,
      agentTools: 1,
      perGroup: 1,
      requestsPerSecond: 10,
    };

    const first = await lanes.acquireSlot("control", { deadlineAt: 100_000, limits: tightLimits });
    expect(first.ok).toBe(true);

    const secondPromise = lanes.acquireSlot("control", { deadlineAt: 5_000, limits: tightLimits });
    await vi.advanceTimersByTimeAsync(5_001);
    const second = await secondPromise;

    expect(second).toEqual({ ok: false, reason: "saturated" });
    expect(lanes.circuits.control.state(Date.now())).toBe("closed");
  });

  test("takeRateToken serves waiting control requests before waiting agentTools ones", async () => {
    const lanes = new JevLanes();
    const rateLimits: JevLaneLimits = {
      control: 4,
      agentTools: 4,
      perGroup: 4,
      requestsPerSecond: 1,
    };

    const initial = await lanes.takeRateToken("control", {
      deadlineAt: 100_000,
      limits: rateLimits,
    });
    expect(initial.ok).toBe(true);

    const toolPromise = lanes.takeRateToken("agentTools", {
      deadlineAt: 100_000,
      limits: rateLimits,
    });
    const toolFlag = settledFlag(toolPromise);
    await Promise.resolve();

    const controlPromise = lanes.takeRateToken("control", {
      deadlineAt: 100_000,
      limits: rateLimits,
    });
    const controlFlag = settledFlag(controlPromise);
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(controlFlag.settled).toBe(true);
    expect(toolFlag.settled).toBe(false);
    expect(await controlPromise).toEqual({ ok: true });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await toolPromise).toEqual({ ok: true });
  });

  test("aborting a queued acquireSlot resolves it as aborted", async () => {
    const lanes = new JevLanes();
    const tightLimits: JevLaneLimits = {
      control: 1,
      agentTools: 1,
      perGroup: 1,
      requestsPerSecond: 10,
    };
    const first = await lanes.acquireSlot("control", { deadlineAt: 100_000, limits: tightLimits });
    expect(first.ok).toBe(true);

    const controller = new AbortController();
    const secondPromise = lanes.acquireSlot("control", {
      deadlineAt: 100_000,
      limits: tightLimits,
      signal: controller.signal,
    });
    controller.abort();
    expect(await secondPromise).toEqual({ ok: false, reason: "aborted" });
  });

  test("release is idempotent", async () => {
    const lanes = new JevLanes();
    const tightLimits: JevLaneLimits = {
      control: 1,
      agentTools: 1,
      perGroup: 1,
      requestsPerSecond: 10,
    };
    const first = await lanes.acquireSlot("control", { deadlineAt: 100_000, limits: tightLimits });
    if (!first.ok) throw new Error("expected ok");

    first.release();
    first.release();

    expect(lanes.inFlight("control")).toBe(0);
    const second = await lanes.acquireSlot("control", { deadlineAt: 100_000, limits: tightLimits });
    expect(second.ok).toBe(true);
  });

  test("inFlight reports the current lane occupancy", async () => {
    const lanes = new JevLanes();
    expect(lanes.inFlight("control")).toBe(0);
    const first = await lanes.acquireSlot("control", { deadlineAt: 100_000, limits });
    expect(lanes.inFlight("control")).toBe(1);
    if (first.ok) first.release();
    expect(lanes.inFlight("control")).toBe(0);
  });
});
