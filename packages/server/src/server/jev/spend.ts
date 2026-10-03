import type { JevLane } from "./contract.js";

/**
 * In-flight spend (docs/jev.md, "Lanes, deadlines, retries, circuits"). A call reserves its
 * estimate once it holds a lane slot and before its first send. The reservation holds the estimate
 * while the call is out, the actual charge once the send finishes, and goes when the ledger records
 * that charge, so recorded plus reserved counts every call exactly once. Without it, calls queued
 * at the same moment all pass a check against spend already recorded.
 */

/** The per-agent hourly bucket for an `agentTools` call that names no agent. */
export const JEV_UNATTRIBUTED_AGENT = "(unattributed)";

/** How many reported charges the per-byte rate is taken from. */
const OBSERVED_RATES = 20;

export interface JevSpendReservation {
  readonly lane: JevLane;
  /** The per-agent bucket, `agentTools` only. */
  readonly agentId: string | null;
  readonly bodyBytes: number;
  readonly estimateUsd: number;
  /** The actual charge, once the send has finished. */
  settledUsd: number | null;
}

export class JevSpendReservations {
  private readonly open = new Set<JevSpendReservation>();
  private readonly observedUsdPerByte: number[] = [];

  /**
   * The list-price estimate, raised to the highest per-byte rate among recent reported charges.
   * The list price counts input tokens only, and a call billed several times that would otherwise
   * be reserved at a fraction of what it costs.
   */
  estimate(bodyBytes: number, listPriceUsd: number): number {
    return Math.max(listPriceUsd, bodyBytes * this.highestObservedRate());
  }

  /** A charge JEV reported, for the per-byte rate. Estimated charges teach nothing. */
  observe(usd: number, bodyBytes: number): void {
    if (!Number.isFinite(usd) || usd <= 0 || bodyBytes <= 0) return;
    this.observedUsdPerByte.push(usd / bodyBytes);
    if (this.observedUsdPerByte.length > OBSERVED_RATES) this.observedUsdPerByte.shift();
  }

  reserve(input: {
    lane: JevLane;
    agentId: string | null;
    bodyBytes: number;
    estimateUsd: number;
  }): JevSpendReservation {
    const reservation: JevSpendReservation = { ...input, settledUsd: null };
    this.open.add(reservation);
    return reservation;
  }

  settle(reservation: JevSpendReservation, usd: number | null): void {
    reservation.settledUsd = usd ?? reservation.estimateUsd;
  }

  release(reservation: JevSpendReservation): void {
    this.open.delete(reservation);
  }

  reservedUsd(lane: JevLane): number {
    let total = 0;
    for (const reservation of this.open) {
      if (reservation.lane === lane) total += this.heldUsd(reservation);
    }
    return total;
  }

  reservedForAgentUsd(agentId: string): number {
    let total = 0;
    for (const reservation of this.open) {
      if (reservation.agentId === agentId) total += this.heldUsd(reservation);
    }
    return total;
  }

  /** An unsettled reservation is re-estimated at today's rate: a first wave sent before any charge
   * was reported would otherwise be held at the list price after the first answer shows the real
   * one. */
  private heldUsd(reservation: JevSpendReservation): number {
    if (reservation.settledUsd !== null) return reservation.settledUsd;
    return Math.max(reservation.estimateUsd, reservation.bodyBytes * this.highestObservedRate());
  }

  private highestObservedRate(): number {
    let highest = 0;
    for (const rate of this.observedUsdPerByte) highest = Math.max(highest, rate);
    return highest;
  }
}
