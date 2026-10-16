/**
 * One unit for the brakes and the build gate: what their messages and ledger records say, so a
 * person comparing a hold to a refusal reads the same number.
 */

export const GIBIBYTE = 1024 ** 3;

/** `31.9 GB`: gibibytes, one decimal. */
export function formatGigabytes(bytes: number): string {
  return `${(bytes / GIBIBYTE).toFixed(1)} GB`;
}
