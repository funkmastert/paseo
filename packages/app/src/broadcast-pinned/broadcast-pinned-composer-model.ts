import type { BroadcastPinnedTarget } from "./broadcast-pinned-targets";

export interface BroadcastPinnedComposerSnapshot {
  text: string;
  checked: ReadonlySet<string>;
  canSend: boolean;
}

export interface BroadcastPinnedComposerModel {
  subscribe: (listener: () => void) => () => void;
  snapshot: () => BroadcastPinnedComposerSnapshot;
  setText: (text: string) => void;
  toggleTarget: (id: string) => void;
}

/**
 * Draft text and the set of checked targets for the broadcast composer. Plain TS, per
 * docs/forms.md: constructed once per popover open, never reconstructed from live data, so an
 * in-progress draft survives a target list that changes underneath it.
 */
export function createBroadcastPinnedComposerModel(
  targets: readonly BroadcastPinnedTarget[],
): BroadcastPinnedComposerModel {
  let text = "";
  let checked: ReadonlySet<string> = new Set(targets.map((target) => target.id));
  let cachedSnapshot: BroadcastPinnedComposerSnapshot | null = null;
  const listeners = new Set<() => void>();

  function notify(): void {
    cachedSnapshot = null;
    for (const listener of listeners) listener();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot() {
      if (!cachedSnapshot) {
        cachedSnapshot = { text, checked, canSend: text.trim() !== "" && checked.size > 0 };
      }
      return cachedSnapshot;
    },
    setText(next) {
      text = next;
      notify();
    },
    toggleTarget(id) {
      const next = new Set(checked);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      checked = next;
      notify();
    },
  };
}
