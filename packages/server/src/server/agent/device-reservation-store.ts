/**
 * Devices Tyler reserved for himself, by hand, from the Devices UI. Checkout and the launch gate
 * never hand a reserved device to an agent (docs/device-leases.md); everything else unheld and
 * unreserved is fair game for reuse.
 *
 * Persisted, unlike leases: a lease is bookkeeping about what is running right now and rebuilds
 * itself from the process scan after a restart, but a reservation is a standing decision Tyler
 * made that has nothing to do with whether a device happens to be running at this instant.
 */

import { existsSync, readFileSync } from "node:fs";
import type pino from "pino";
import { z } from "zod";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";

const ReservationSchema = z.object({
  deviceId: z.string(),
  reservedAtMs: z.number(),
});

const StoredReservationsSchema = z.object({
  reservations: z.array(ReservationSchema),
});

export interface DeviceReservation {
  deviceId: string;
  reservedAtMs: number;
}

export class DeviceReservationStore {
  private reservations: DeviceReservation[] = [];
  private readonly logger: pino.Logger;

  constructor(
    logger: pino.Logger,
    private readonly filePath: string,
    private readonly write: typeof writePrivateFileAtomicSync = writePrivateFileAtomicSync,
  ) {
    this.logger = logger.child({ component: "device-reservation-store" });
    this.load();
  }

  list(): readonly DeviceReservation[] {
    return this.reservations;
  }

  reservedDeviceIds(): ReadonlySet<string> {
    return new Set(this.reservations.map((reservation) => reservation.deviceId));
  }

  isReserved(deviceId: string): boolean {
    return this.reservations.some((reservation) => reservation.deviceId === deviceId);
  }

  reserve(deviceId: string, nowMs: number): void {
    if (this.isReserved(deviceId)) return;
    this.reservations = [...this.reservations, { deviceId, reservedAtMs: nowMs }];
    this.persist();
  }

  unreserve(deviceId: string): void {
    if (!this.isReserved(deviceId)) return;
    this.reservations = this.reservations.filter(
      (reservation) => reservation.deviceId !== deviceId,
    );
    this.persist();
  }

  private persist(): void {
    this.write(this.filePath, JSON.stringify({ reservations: this.reservations }, null, 2) + "\n");
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      ensurePrivateFile(this.filePath);
      const parsed = StoredReservationsSchema.parse(
        JSON.parse(readFileSync(this.filePath, "utf-8")),
      );
      this.reservations = parsed.reservations;
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to load device reservations; starting empty");
    }
  }
}
