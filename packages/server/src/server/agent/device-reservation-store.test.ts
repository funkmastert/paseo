import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DeviceReservationStore } from "./device-reservation-store.js";

const logger = pino({ level: "silent" });

describe("DeviceReservationStore", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "device-reservation-store-"));
    filePath = join(dir, "device-reservations.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("starts empty when no file exists", () => {
    const store = new DeviceReservationStore(logger, filePath);
    expect(store.list()).toEqual([]);
    expect(store.isReserved("UDID-1")).toBe(false);
  });

  test("reserves a device and reports it reserved", () => {
    const store = new DeviceReservationStore(logger, filePath);
    store.reserve("UDID-1", 1_000);

    expect(store.isReserved("UDID-1")).toBe(true);
    expect(store.reservedDeviceIds()).toEqual(new Set(["UDID-1"]));
  });

  test("unreserving a device nobody reserved is a no-op", () => {
    const store = new DeviceReservationStore(logger, filePath);
    store.unreserve("UDID-1");

    expect(store.list()).toEqual([]);
  });

  test("survives a restart: a fresh store reads what the last one wrote", () => {
    new DeviceReservationStore(logger, filePath).reserve("UDID-1", 1_000);

    const reopened = new DeviceReservationStore(logger, filePath);
    expect(reopened.isReserved("UDID-1")).toBe(true);
  });

  test("unreserve persists across a restart too", () => {
    const store = new DeviceReservationStore(logger, filePath);
    store.reserve("UDID-1", 1_000);
    store.unreserve("UDID-1");

    const reopened = new DeviceReservationStore(logger, filePath);
    expect(reopened.isReserved("UDID-1")).toBe(false);
  });

  test("a malformed file falls back to empty rather than throwing", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, "not json");

    const store = new DeviceReservationStore(logger, filePath);
    expect(store.list()).toEqual([]);
  });
});
