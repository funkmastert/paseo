import { describe, expect, it } from "vitest";

import { lowerProcessPriority, type PriorityOps } from "./process-priority.js";

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
