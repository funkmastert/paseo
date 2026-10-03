import { describe, expect, it } from "vitest";
import {
  DISK_USAGE_DANGER_BYTES,
  DISK_USAGE_FLOOR_BYTES,
  DISK_USAGE_WARN_BYTES,
  formatDiskUsageSize,
  resolveDiskUsageTone,
} from "./disk-usage-tone-model";

describe("resolveDiskUsageTone", () => {
  it("shows nothing when unsampled", () => {
    expect(resolveDiskUsageTone(undefined)).toBeUndefined();
  });

  it("shows nothing just below the floor", () => {
    expect(resolveDiskUsageTone(DISK_USAGE_FLOOR_BYTES - 1)).toBeUndefined();
  });

  it("is muted at the floor", () => {
    expect(resolveDiskUsageTone(DISK_USAGE_FLOOR_BYTES)).toBe("muted");
  });

  it("is muted just below the warn threshold", () => {
    expect(resolveDiskUsageTone(DISK_USAGE_WARN_BYTES - 1)).toBe("muted");
  });

  it("is warning at the warn threshold", () => {
    expect(resolveDiskUsageTone(DISK_USAGE_WARN_BYTES)).toBe("warning");
  });

  it("is warning just below the danger threshold", () => {
    expect(resolveDiskUsageTone(DISK_USAGE_DANGER_BYTES - 1)).toBe("warning");
  });

  it("is danger at the danger threshold", () => {
    expect(resolveDiskUsageTone(DISK_USAGE_DANGER_BYTES)).toBe("danger");
  });
});

describe("formatDiskUsageSize", () => {
  it("formats a fractional GiB count with one decimal place", () => {
    expect(formatDiskUsageSize(2.4 * 1024 ** 3)).toBe("2.4 GB");
  });

  it("formats exactly 1 GiB with a trailing decimal", () => {
    expect(formatDiskUsageSize(1024 ** 3)).toBe("1.0 GB");
  });
});
