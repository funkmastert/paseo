import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PROCESS_PRIORITY_POLICY,
  getProcessPriorityPolicy,
  lowerAgentProcessPriority,
  lowerBackgroundProcessPriority,
  lowerProcessPriority,
  resetProcessPriorityPolicy,
  setProcessPriorityPolicy,
  type PriorityOps,
} from "./process-priority.js";

function fakeOps(initial: Record<number, number>): PriorityOps & { niceOf(pid: number): number } {
  const nice = new Map(Object.entries(initial).map(([pid, value]) => [Number(pid), value]));
  return {
    getPriority(pid) {
      const value = nice.get(pid);
      if (value === undefined) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      return value;
    },
    setPriority(pid, value) {
      if (!nice.has(pid)) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      nice.set(pid, value);
    },
    niceOf(pid) {
      return nice.get(pid) ?? Number.NaN;
    },
  };
}

describe("lowerProcessPriority", () => {
  it("lowers a normal-priority process to the target nice", () => {
    const ops = fakeOps({ 42: 0 });
    expect(lowerProcessPriority(42, 10, ops)).toBe("lowered");
    expect(ops.niceOf(42)).toBe(10);
  });

  it("never raises a process that already runs lower than the target", () => {
    const ops = fakeOps({ 42: 15 });
    expect(lowerProcessPriority(42, 10, ops)).toBe("unchanged");
    expect(ops.niceOf(42)).toBe(15);
  });

  it("leaves a process already at the target alone", () => {
    const ops = fakeOps({ 42: 10 });
    expect(lowerProcessPriority(42, 10, ops)).toBe("unchanged");
  });

  it("clamps the target to the platform's nice range", () => {
    const ops = fakeOps({ 42: 0 });
    expect(lowerProcessPriority(42, 40, ops)).toBe("lowered");
    expect(ops.niceOf(42)).toBe(19);
  });

  it("does nothing for a missing pid or a non-positive target", () => {
    const ops = fakeOps({ 42: 0 });
    expect(lowerProcessPriority(undefined, 10, ops)).toBe("unchanged");
    expect(lowerProcessPriority(42, 0, ops)).toBe("unchanged");
    expect(ops.niceOf(42)).toBe(0);
  });

  it("reports a process that exited or cannot be touched as failed, without throwing", () => {
    const ops = fakeOps({});
    expect(lowerProcessPriority(42, 10, ops)).toBe("failed");
  });
});

describe("process priority policy", () => {
  afterEach(() => {
    resetProcessPriorityPolicy();
  });

  it("defaults to lowering agents and background work to 10", () => {
    expect(getProcessPriorityPolicy()).toEqual({
      enabled: true,
      agentNice: 10,
      backgroundNice: 10,
    });
    expect(DEFAULT_PROCESS_PRIORITY_POLICY).toEqual(getProcessPriorityPolicy());
  });

  it("fills unset fields from the defaults", () => {
    setProcessPriorityPolicy({ agentNice: 15 });
    expect(getProcessPriorityPolicy()).toEqual({
      enabled: true,
      agentNice: 15,
      backgroundNice: 10,
    });
  });

  it("replaces the previous policy rather than merging into it", () => {
    setProcessPriorityPolicy({ agentNice: 15, backgroundNice: 5 });
    setProcessPriorityPolicy({ enabled: false });
    expect(getProcessPriorityPolicy()).toEqual({
      enabled: false,
      agentNice: 10,
      backgroundNice: 10,
    });
    setProcessPriorityPolicy(undefined);
    expect(getProcessPriorityPolicy()).toEqual(DEFAULT_PROCESS_PRIORITY_POLICY);
  });

  it("lowers agent processes to agentNice and background ones to backgroundNice", () => {
    setProcessPriorityPolicy({ agentNice: 12, backgroundNice: 7 });
    const ops = fakeOps({ 1: 0, 2: 0 });
    expect(lowerAgentProcessPriority(1, ops)).toBe("lowered");
    expect(lowerBackgroundProcessPriority(2, ops)).toBe("lowered");
    expect(ops.niceOf(1)).toBe(12);
    expect(ops.niceOf(2)).toBe(7);
  });

  it("touches nothing while disabled", () => {
    setProcessPriorityPolicy({ enabled: false });
    const ops = fakeOps({ 1: 0 });
    expect(lowerAgentProcessPriority(1, ops)).toBe("unchanged");
    expect(lowerBackgroundProcessPriority(1, ops)).toBe("unchanged");
    expect(ops.niceOf(1)).toBe(0);
  });

  it("treats a nice of 0 as leaving the process at normal priority", () => {
    setProcessPriorityPolicy({ agentNice: 0 });
    const ops = fakeOps({ 1: 0 });
    expect(lowerAgentProcessPriority(1, ops)).toBe("unchanged");
  });
});
