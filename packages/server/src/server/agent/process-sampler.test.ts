import { describe, expect, test } from "vitest";
import { parseMacosSwapUsage, parseProcMeminfo, parsePsOutput } from "./process-sampler.js";

describe("parsePsOutput", () => {
  test("parses a macOS-shaped snapshot, including a command containing spaces", () => {
    const output = [
      "  PID  PPID    RSS %CPU     ELAPSED COMMAND",
      "  501     1   2048   0.0     01:23:45 /usr/bin/login -pfl tyler /bin/zsh -c exec /bin/zsh -il",
      " 1200   501  51200  45.2       00:01 git push origin main",
      "",
    ].join("\n");

    const rows = parsePsOutput(output);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      pid: 501,
      ppid: 1,
      rssKb: 2048,
      cpuPercent: 0,
      etime: "01:23:45",
      command: "/usr/bin/login -pfl tyler /bin/zsh -c exec /bin/zsh -il",
    });
    expect(rows[1]).toEqual({
      pid: 1200,
      ppid: 501,
      rssKb: 51200,
      cpuPercent: 45.2,
      etime: "00:01",
      command: "git push origin main",
    });
  });

  test("recognizes a detached Gradle daemon by ppid 1 and its command marker", () => {
    const output = [
      "  PID  PPID    RSS %CPU     ELAPSED COMMAND",
      " 2001     1 445000   0.1    2:14:00 java -Xmx2g -cp gradle-launcher.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon",
    ].join("\n");

    const rows = parsePsOutput(output);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.ppid).toBe(1);
    expect(rows[0]?.command).toContain("GradleDaemon");
  });

  test("drops malformed lines instead of throwing", () => {
    const output = ["  PID  PPID    RSS %CPU     ELAPSED COMMAND", "not a process line", ""].join(
      "\n",
    );

    expect(parsePsOutput(output)).toEqual([]);
  });

  test("an empty snapshot (header only) parses to no rows", () => {
    expect(parsePsOutput("  PID  PPID    RSS %CPU     ELAPSED COMMAND\n")).toEqual([]);
  });
});

describe("parseMacosSwapUsage", () => {
  test("parses total/used amounts across K/M/G units", () => {
    const result = parseMacosSwapUsage(
      "vm.swapusage: total = 9216.00M  used = 8478.00M  free = 738.00M  (encrypted)",
    );

    expect(result).toEqual({ swapTotalBytes: 9216 * 1024 ** 2, swapUsedBytes: 8478 * 1024 ** 2 });
  });

  test("returns undefined on unrecognized output", () => {
    expect(parseMacosSwapUsage("unexpected output")).toBeUndefined();
  });
});

describe("parseProcMeminfo", () => {
  test("computes swap used as total minus free", () => {
    const content = [
      "MemTotal:       65894400 kB",
      "MemFree:         1048576 kB",
      "SwapTotal:       8388608 kB",
      "SwapFree:         262144 kB",
      "",
    ].join("\n");

    const result = parseProcMeminfo(content);

    expect(result).toEqual({
      totalPhysicalBytes: 65894400 * 1024,
      swapTotalBytes: 8388608 * 1024,
      swapUsedBytes: (8388608 - 262144) * 1024,
    });
  });

  test("returns undefined when the expected keys are missing", () => {
    expect(parseProcMeminfo("Nothing:matches here\n")).toBeUndefined();
  });
});
