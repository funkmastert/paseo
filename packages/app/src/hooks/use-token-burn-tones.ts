import { useEffect, useMemo, useRef, useState } from "react";
import { subscribeToRelativeTimeTick } from "@/utils/relative-time-ticker";
import {
  deriveTokenBurnTones,
  type TokenBurnSibling,
  type TokenBurnTone,
} from "@/utils/token-burn-tone-model";

function sameTones(
  left: ReadonlyMap<string, TokenBurnTone>,
  right: ReadonlyMap<string, TokenBurnTone>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [id, tone] of left) {
    if (right.get(id) !== tone) return false;
  }
  return true;
}

/**
 * The keyed token-burn tone model for a list owner, kept honest about time.
 *
 * `deriveTokenBurnTones` rejects a rate older than `TOKEN_BURN_STALENESS_MS`, but that cutoff is
 * only applied at the moment it is called. Deriving inside a `useMemo` keyed on the rows freezes
 * `Date.now()` with them: when a fleet goes quiet no agent update arrives, the rows keep their
 * identity, the memo never re-runs, and every badge assigned on the last active render stays lit
 * for as long as the panel is open. A "High burn" badge on an agent that stopped an hour ago is
 * the exact failure the cutoff exists to prevent.
 *
 * So the derivation re-runs on the shared minute tick as well as on row changes — but only while
 * there is a badge that could expire. A list with no tones subscribes to nothing and runs no
 * timer, and the returned map keeps its identity while the tones are unchanged, so a tick that
 * expires nothing re-renders no rows.
 */
export function useTokenBurnTones(
  siblings: readonly TokenBurnSibling[],
): ReadonlyMap<string, TokenBurnTone> {
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Hysteresis carries across renders; see deriveTokenBurnTones. Committing it belongs in an
  // effect, not the memo factory — useMemo must stay pure under Strict Mode's double invoke.
  const previousTonesRef = useRef<ReadonlyMap<string, TokenBurnTone>>(new Map());
  const lastReturnedRef = useRef<ReadonlyMap<string, TokenBurnTone>>(new Map());

  const tones = useMemo(() => {
    const next = deriveTokenBurnTones(siblings, previousTonesRef.current, nowMs);
    return sameTones(next, lastReturnedRef.current) ? lastReturnedRef.current : next;
  }, [nowMs, siblings]);

  useEffect(() => {
    previousTonesRef.current = tones;
    lastReturnedRef.current = tones;
  }, [tones]);

  const hasExpirableTone = tones.size > 0;
  useEffect(() => {
    if (!hasExpirableTone) return undefined;
    return subscribeToRelativeTimeTick("minute", () => setNowMs(Date.now()));
  }, [hasExpirableTone]);

  return tones;
}
