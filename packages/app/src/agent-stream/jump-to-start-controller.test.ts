import { describe, expect, it, vi } from "vitest";
import { createJumpToStartController } from "./jump-to-start-controller";

interface FakeFrameScheduler {
  requestFrame(callback: () => void): number;
  cancelFrame(frameId: number): void;
  runNextFrame(): void;
  pendingFrames(): number;
}

function createFakeFrameScheduler(): FakeFrameScheduler {
  const frames = new Map<number, () => void>();
  let nextFrameId = 1;
  return {
    requestFrame(callback) {
      const frameId = nextFrameId;
      nextFrameId += 1;
      frames.set(frameId, callback);
      return frameId;
    },
    cancelFrame(frameId) {
      frames.delete(frameId);
    },
    runNextFrame() {
      const next = frames.entries().next().value;
      if (!next) {
        throw new Error("Expected a pending jump-to-start frame");
      }
      const [frameId, callback] = next;
      frames.delete(frameId);
      callback();
    },
    pendingFrames() {
      return frames.size;
    },
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createJumpToStartController", () => {
  it("scrolls to start immediately when already at the oldest loaded history", () => {
    const scheduler = createFakeFrameScheduler();
    const scrollToStart = vi.fn();
    const loadOlder = vi.fn();
    const controller = createJumpToStartController({
      hasOlderHistory: () => false,
      isLoadingOlderHistory: () => false,
      loadOlder,
      scrollToStart,
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
    });

    controller.start();
    expect(controller.isActive()).toBe(true);
    scheduler.runNextFrame();

    expect(loadOlder).not.toHaveBeenCalled();
    expect(scrollToStart).toHaveBeenCalledTimes(1);
    expect(controller.isActive()).toBe(false);
  });

  it("pages through older history until exhausted, then lands at the top", async () => {
    const scheduler = createFakeFrameScheduler();
    const scrollToStart = vi.fn();
    let remainingPages = 3;
    const loadOlder = vi.fn(async () => {
      remainingPages -= 1;
      return true;
    });
    const onSettle = vi.fn();
    const controller = createJumpToStartController({
      hasOlderHistory: () => remainingPages > 0,
      isLoadingOlderHistory: () => false,
      loadOlder,
      scrollToStart,
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
      onSettle,
    });

    controller.start();
    for (let i = 0; i < 3; i++) {
      scheduler.runNextFrame();
      await flushMicrotasks();
    }
    scheduler.runNextFrame();

    expect(loadOlder).toHaveBeenCalledTimes(3);
    expect(scrollToStart).toHaveBeenCalledTimes(1);
    expect(controller.isActive()).toBe(false);
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it("does not start a new load while one is already in flight", async () => {
    const scheduler = createFakeFrameScheduler();
    let resolveLoad = (): void => {};
    let hasOlder = true;
    const loadOlder = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveLoad = () => resolve(true);
        }),
    );
    const controller = createJumpToStartController({
      hasOlderHistory: () => hasOlder,
      isLoadingOlderHistory: () => false,
      loadOlder,
      scrollToStart: vi.fn(),
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
    });

    controller.start();
    scheduler.runNextFrame();
    scheduler.runNextFrame();
    scheduler.runNextFrame();
    expect(loadOlder).toHaveBeenCalledTimes(1);

    hasOlder = false;
    resolveLoad();
    await flushMicrotasks();
    scheduler.runNextFrame();
    expect(controller.isActive()).toBe(false);
  });

  it("cancel stops the controller without scrolling to start", () => {
    const scheduler = createFakeFrameScheduler();
    const scrollToStart = vi.fn();
    const onSettle = vi.fn();
    const controller = createJumpToStartController({
      hasOlderHistory: () => true,
      isLoadingOlderHistory: () => false,
      loadOlder: vi.fn(() => new Promise<boolean>(() => {})),
      scrollToStart,
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
      onSettle,
    });

    controller.start();
    scheduler.runNextFrame();
    expect(controller.isActive()).toBe(true);

    controller.cancel();

    expect(controller.isActive()).toBe(false);
    expect(scrollToStart).not.toHaveBeenCalled();
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(scheduler.pendingFrames()).toBe(0);
  });

  it("start() is a no-op while already active", () => {
    const scheduler = createFakeFrameScheduler();
    const controller = createJumpToStartController({
      hasOlderHistory: () => true,
      isLoadingOlderHistory: () => false,
      loadOlder: vi.fn(() => new Promise<boolean>(() => {})),
      scrollToStart: vi.fn(),
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
    });

    controller.start();
    controller.start();
    expect(scheduler.pendingFrames()).toBe(1);
  });
});
