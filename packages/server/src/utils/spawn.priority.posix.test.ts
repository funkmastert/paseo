import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { execCommand, runWithSpawnPriority, spawnProcess } from "./spawn.js";
import { resetProcessPriorityPolicy, setProcessPriorityPolicy } from "./process-priority.js";

// Real processes through the real spawn path: the nice value the kernel reports is the behavior.
// The values differ from 10 because the test runner may itself already run at nice 10.
describe("spawn priority option", () => {
  afterEach(() => {
    resetProcessPriorityPolicy();
  });

  it("lowers an agent process to agentNice (12) and leaves a plain spawn at normal priority", async () => {
    setProcessPriorityPolicy({ agentNice: 12, backgroundNice: 15 });
    const agent = spawnProcess("sleep", ["5"], { priority: "agent", stdio: "ignore" });
    const plain = spawnProcess("sleep", ["5"], { stdio: "ignore" });
    try {
      expect(os.getPriority(agent.pid ?? 0)).toBe(12);
      expect(os.getPriority(plain.pid ?? 0)).toBe(os.getPriority(process.pid));
    } finally {
      agent.kill();
      plain.kill();
    }
  });

  it("lowers a background process to backgroundNice", () => {
    setProcessPriorityPolicy({ agentNice: 12, backgroundNice: 15 });
    const child = spawnProcess("sleep", ["5"], { priority: "background", stdio: "ignore" });
    try {
      expect(os.getPriority(child.pid ?? 0)).toBe(15);
    } finally {
      child.kill();
    }
  });

  it("does not lower anything while the policy is disabled", () => {
    setProcessPriorityPolicy({ enabled: false });
    const child = spawnProcess("sleep", ["5"], { priority: "agent", stdio: "ignore" });
    try {
      expect(os.getPriority(child.pid ?? 0)).toBe(os.getPriority(process.pid));
    } finally {
      child.kill();
    }
  });

  it("runs a background execCommand at backgroundNice, and its children inherit it", async () => {
    setProcessPriorityPolicy({ backgroundNice: 15 });
    const { stdout } = await execCommand("sh", ["-c", "sleep 0.2; sh -c 'ps -o ni= -p $$'"], {
      priority: "background",
    });
    expect(Number(stdout.trim())).toBe(15);
  });
});

describe("runWithSpawnPriority", () => {
  afterEach(() => {
    resetProcessPriorityPolicy();
  });

  it("gives spawns inside the scope, however deep, the scope's priority", async () => {
    setProcessPriorityPolicy({ agentNice: 12, backgroundNice: 15 });
    const inside = await runWithSpawnPriority("background", async () => {
      await Promise.resolve();
      return spawnProcess("sleep", ["5"], { stdio: "ignore" });
    });
    const outside = spawnProcess("sleep", ["5"], { stdio: "ignore" });
    const explicit = await runWithSpawnPriority("background", async () =>
      spawnProcess("sleep", ["5"], { priority: "agent", stdio: "ignore" }),
    );
    try {
      expect(os.getPriority(inside.pid ?? 0)).toBe(15);
      expect(os.getPriority(outside.pid ?? 0)).toBe(os.getPriority(process.pid));
      expect(os.getPriority(explicit.pid ?? 0)).toBe(12);
    } finally {
      inside.kill();
      outside.kill();
      explicit.kill();
    }
  });
});
