import os from "node:os";
import { describe, expect, test, vi } from "vitest";
import { BACKGROUND_NICE, SAMPLER_NICE } from "../../utils/process-priority.js";
import {
  createSystemProcessSampler,
  execFileAtLowPriority,
  parseClockSeconds,
  parseMacosSwapUsage,
  parseMacosVmStat,
  parseProcMeminfo,
  parsePsOutput,
  parseWindowsProcessJson,
} from "./process-sampler.js";

const GIBIBYTE = 1024 ** 3;

describe("parsePsOutput", () => {
  test("parses a macOS-shaped snapshot, including a command containing spaces", () => {
    const output = [
      "  PID  PPID   UID    RSS %CPU     ELAPSED        TIME COMMAND",
      "  501     1   501   2048   0.0     01:23:45     0:00.05 /usr/bin/login -pfl tyler /bin/zsh -c exec /bin/zsh -il",
      " 1200   501   501  51200  45.2       00:01     0:00.45 git push origin main",
      "",
    ].join("\n");

    const rows = parsePsOutput(output);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      pid: 501,
      ppid: 1,
      uid: 501,
      rssKb: 2048,
      cpuPercent: 0,
      etime: "01:23:45",
      cpuSeconds: 0.05,
      command: "/usr/bin/login -pfl tyler /bin/zsh -c exec /bin/zsh -il",
    });
    expect(rows[1]).toEqual({
      pid: 1200,
      ppid: 501,
      uid: 501,
      rssKb: 51200,
      cpuPercent: 45.2,
      etime: "00:01",
      cpuSeconds: 0.45,
      command: "git push origin main",
    });
  });

  test("recognizes a detached Gradle daemon by ppid 1 and its command marker", () => {
    const output = [
      "  PID  PPID   UID    RSS %CPU     ELAPSED        TIME COMMAND",
      " 2001     1   501 445000   0.1    2:14:00    12:34.56 java -Xmx2g -cp gradle-launcher.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon",
    ].join("\n");

    const rows = parsePsOutput(output);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.ppid).toBe(1);
    expect(rows[0]?.command).toContain("GradleDaemon");
  });

  test("drops malformed lines instead of throwing", () => {
    const output = [
      "  PID  PPID   UID    RSS %CPU     ELAPSED        TIME COMMAND",
      "not a process line",
      "",
    ].join("\n");

    expect(parsePsOutput(output)).toEqual([]);
  });

  test("an empty snapshot (header only) parses to no rows", () => {
    expect(
      parsePsOutput("  PID  PPID   UID    RSS %CPU     ELAPSED        TIME COMMAND\n"),
    ).toEqual([]);
  });

  test("a row whose TIME column doesn't parse still counts, just without cpuSeconds", () => {
    const output = [
      "  PID  PPID   UID    RSS %CPU     ELAPSED        TIME COMMAND",
      "   77     1     0   1000   1.0       00:10          ?? some-tool",
    ].join("\n");

    expect(parsePsOutput(output)[0]).toEqual({
      pid: 77,
      ppid: 1,
      uid: 0,
      rssKb: 1000,
      cpuPercent: 1,
      etime: "00:10",
      command: "some-tool",
    });
  });
});

describe("parseClockSeconds", () => {
  test("reads every ps clock shape seen on macOS and Linux", () => {
    expect(parseClockSeconds("0:00.05")).toBeCloseTo(0.05);
    expect(parseClockSeconds("12:34.56")).toBeCloseTo(754.56);
    expect(parseClockSeconds("01:23:45")).toBe(5025);
    expect(parseClockSeconds("2-01:02:03")).toBe(2 * 86_400 + 3723);
  });

  test("returns undefined for anything else", () => {
    expect(parseClockSeconds("??")).toBeUndefined();
    expect(parseClockSeconds("")).toBeUndefined();
    expect(parseClockSeconds("12")).toBeUndefined();
  });
});

describe("createSystemProcessSampler", () => {
  function createLogger() {
    return { info: vi.fn(), warn: vi.fn() };
  }

  const PS_OUTPUT = [
    "  PID  PPID   UID    RSS %CPU     ELAPSED        TIME COMMAND",
    "    9     1   501    512   0.0       00:05     0:00.01 sleep 60",
  ].join("\n");

  test("a failed sample says it failed, so callers can tell it from an empty machine", async () => {
    const sampler = createSystemProcessSampler({
      logger: createLogger(),
      readProcessTable: async () => {
        throw Object.assign(new Error("spawn ps ETIMEDOUT"), { code: "ETIMEDOUT" });
      },
    });

    const sample = await sampler.sampleProcessTable();

    expect(sample.status).toBe("failed");
    // The legacy method keeps its contract for the callers that treat [] as "no signal".
    expect(await sampler.sampleProcesses()).toEqual([]);
  });

  test("a table with no rows in it is a failed sample, not an idle machine", async () => {
    const sampler = createSystemProcessSampler({
      logger: createLogger(),
      readProcessTable: async () => [],
    });

    expect((await sampler.sampleProcessTable()).status).toBe("failed");
  });

  test("warns once per failure streak and logs recovery, so a second outage is not silent", async () => {
    const logger = createLogger();
    let failing = true;
    const sampler = createSystemProcessSampler({
      logger,
      readProcessTable: async () => {
        if (failing) throw new Error("ps timed out");
        return parsePsOutput(PS_OUTPUT);
      },
    });

    await sampler.sampleProcessTable();
    await sampler.sampleProcessTable();
    expect(logger.warn).toHaveBeenCalledTimes(1);

    failing = false;
    expect((await sampler.sampleProcessTable()).status).toBe("ok");
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0]?.[0]).toMatchObject({ failedSamples: 2 });

    failing = true;
    await sampler.sampleProcessTable();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  test("returns whatever the process table holds", async () => {
    const sampler = createSystemProcessSampler({
      logger: createLogger(),
      readProcessTable: async () => parsePsOutput(PS_OUTPUT),
    });

    expect(await sampler.sampleProcessTable()).toEqual({
      status: "ok",
      rows: [
        {
          pid: 9,
          ppid: 1,
          uid: 501,
          rssKb: 512,
          cpuPercent: 0,
          etime: "00:05",
          cpuSeconds: 0.01,
          command: "sleep 60",
        },
      ],
    });
  });
});

describe("execFileAtLowPriority", () => {
  test("runs the sampling child below normal priority but ahead of agent processes", async () => {
    // The child reports its own priority after a pause long enough for the parent to have
    // lowered it; the parent lowers it synchronously right after spawning.
    const stdout = await execFileAtLowPriority(
      process.execPath,
      ["-e", "setTimeout(() => console.log(require('node:os').getPriority()), 300)"],
      { timeout: 10_000 },
    );

    // Windows has no class between NORMAL and BELOW_NORMAL; libuv maps 5 to NORMAL, read as 0.
    // The child inherits the test runner's priority and is never raised, so a runner started at
    // low priority (an agent's) keeps its own.
    const target = process.platform === "win32" ? 0 : SAMPLER_NICE;
    const expected = Math.max(target, os.getPriority());
    expect(Number.parseInt(stdout.trim(), 10)).toBe(expected);
    expect(SAMPLER_NICE).toBeGreaterThan(0);
    expect(SAMPLER_NICE).toBeLessThan(BACKGROUND_NICE);
  });

  test("asks for SAMPLER_NICE, whatever priority the runner itself has", async () => {
    const getPriority = vi.spyOn(os, "getPriority").mockReturnValue(0);
    const setPriority = vi.spyOn(os, "setPriority").mockImplementation(() => undefined);
    try {
      await execFileAtLowPriority(process.execPath, ["-e", ""], { timeout: 10_000 });
      expect(setPriority).toHaveBeenCalledWith(expect.any(Number), SAMPLER_NICE);
    } finally {
      getPriority.mockRestore();
      setPriority.mockRestore();
    }
  });
});

describe("parseWindowsProcessJson", () => {
  // Shaped like `Get-CimInstance Win32_Process | ... | ConvertTo-Json -Compress` on Windows 11:
  // UInt64 counters come out as numbers, protected processes have a null CommandLine, and the
  // System Idle Process has no CreationDate.
  const output = JSON.stringify([
    {
      ProcessId: 0,
      ParentProcessId: 0,
      WorkingSetSize: 8192,
      UserModeTime: 0,
      KernelModeTime: 0,
      AgeSeconds: null,
      Name: "System Idle Process",
      CommandLine: null,
    },
    {
      ProcessId: 4812,
      ParentProcessId: 3300,
      WorkingSetSize: 1_073_741_824,
      UserModeTime: 3_000_000_000,
      KernelModeTime: 600_000_000,
      AgeSeconds: 90_061,
      Name: "java.exe",
      CommandLine:
        '"C:\\Program Files\\Java\\bin\\java.exe" -Xmx4g org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10',
    },
  ]);

  test("maps each process onto the same row shape ps produces", () => {
    const rows = parseWindowsProcessJson(output);

    expect(rows[1]).toEqual({
      pid: 4812,
      ppid: 3300,
      uid: undefined,
      rssKb: 1_048_576,
      // 360 CPU seconds over 90,061 seconds of life: the lifetime average, like ps's %CPU.
      cpuPercent: (360 / 90_061) * 100,
      etime: "1-01:01:01",
      cpuSeconds: 360,
      command:
        '"C:\\Program Files\\Java\\bin\\java.exe" -Xmx4g org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10',
    });
    expect(parseClockSeconds(rows[1]?.etime ?? "")).toBe(90_061);
  });

  test("never reports a uid, so the reaper never signals anything on Windows", () => {
    expect(parseWindowsProcessJson(output).every((row) => row.uid === undefined)).toBe(true);
  });

  test("falls back to the image name when the command line is hidden", () => {
    expect(parseWindowsProcessJson(output)[0]).toMatchObject({
      command: "System Idle Process",
      cpuPercent: 0,
      etime: "00:00",
    });
  });

  test("accepts a single object, which is what ConvertTo-Json emits for one process", () => {
    const single = JSON.stringify({
      ProcessId: 7,
      ParentProcessId: 4,
      WorkingSetSize: "4096",
      UserModeTime: "10000000",
      KernelModeTime: "0",
      AgeSeconds: 10,
      Name: "a.exe",
      CommandLine: "a.exe --x",
    });

    expect(parseWindowsProcessJson(single)).toEqual([
      {
        pid: 7,
        ppid: 4,
        uid: undefined,
        rssKb: 4,
        cpuPercent: 10,
        etime: "00:10",
        cpuSeconds: 1,
        command: "a.exe --x",
      },
    ]);
  });

  test("drops entries without a numeric pid and returns nothing for output that is not JSON", () => {
    expect(parseWindowsProcessJson(JSON.stringify([{ Name: "x" }]))).toEqual([]);
    expect(parseWindowsProcessJson("Get-CimInstance : Access denied")).toEqual([]);
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

  test("reads MemAvailable for the device-lease headroom gate", () => {
    const content = [
      "MemTotal:       65894400 kB",
      "MemFree:         1048576 kB",
      "MemAvailable:    4194304 kB",
      "SwapTotal:       8388608 kB",
      "SwapFree:         262144 kB",
      "",
    ].join("\n");

    expect(parseProcMeminfo(content)?.availableBytes).toBe(4194304 * 1024);
  });
});

describe("parseMacosVmStat", () => {
  // Real `vm_stat` output from the machine this feature was measured on.
  const output = [
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                                    16876.",
    "Pages active:                                1162500.",
    "Pages inactive:                              1156801.",
    "Pages speculative:                              4342.",
    "Pages throttled:                                   0.",
    "Pages wired down:                             423147.",
    "Pages purgeable:                               25615.",
    '"Translation faults":                   159863805915.',
    "",
  ].join("\n");

  test("counts free, speculative and purgeable pages", () => {
    expect(parseMacosVmStat(output)).toBe((16876 + 4342 + 25615) * 16384);
  });

  test("leaves inactive pages out, so a swapping machine reads as tight as it is", () => {
    // 1,156,801 inactive pages is 17.7 GiB. Counting it would report the thrashing machine as
    // having plenty of room, which is the mistake the gate exists to avoid.
    expect(parseMacosVmStat(output)).toBeLessThan(GIBIBYTE);
  });

  test("returns undefined when the output is not vm_stat's", () => {
    expect(parseMacosVmStat("nothing useful")).toBeUndefined();
  });
});
