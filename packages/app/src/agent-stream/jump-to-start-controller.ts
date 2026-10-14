export interface JumpToStartController {
  start(): void;
  cancel(): void;
  isActive(): boolean;
}

// A page of history can be short, so bound the loop instead of trusting
// hasOlderHistory to always flip to false in a reasonable number of pages.
const MAX_LOAD_ITERATIONS = 2000;

export function createJumpToStartController(input: {
  hasOlderHistory: () => boolean;
  isLoadingOlderHistory: () => boolean;
  loadOlder: () => boolean | Promise<boolean>;
  scrollToStart: () => void;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (frameId: number) => void;
  onSettle?: () => void;
}): JumpToStartController {
  let active = false;
  let frameId: number | null = null;
  let iterations = 0;
  let loadRequested = false;

  function finish(): void {
    if (frameId !== null) input.cancelFrame(frameId);
    const wasActive = active;
    active = false;
    frameId = null;
    iterations = 0;
    loadRequested = false;
    if (wasActive) {
      input.onSettle?.();
    }
  }

  function scheduleNextFrame(): void {
    frameId = input.requestFrame(tick);
  }

  function tick(): void {
    frameId = null;
    if (!active) return;

    if (!input.hasOlderHistory()) {
      input.scrollToStart();
      finish();
      return;
    }

    if (iterations >= MAX_LOAD_ITERATIONS) {
      finish();
      return;
    }

    if (!loadRequested && !input.isLoadingOlderHistory()) {
      loadRequested = true;
      iterations += 1;
      void Promise.resolve(input.loadOlder()).finally(() => {
        loadRequested = false;
      });
    }

    scheduleNextFrame();
  }

  return {
    start() {
      if (active) return;
      active = true;
      iterations = 0;
      loadRequested = false;
      scheduleNextFrame();
    },
    cancel: finish,
    isActive() {
      return active;
    },
  };
}
