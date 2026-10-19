// @vitest-environment jsdom
//
// Renders through a memo'd useSyncExternalStore consumer shaped like the real
// StickyPromptOverlay (view.tsx:354) -- a memo() wrapper reading `source` via
// useSyncExternalStore -- instead of reading source.getState() directly. memo()
// only bails out re-renders the *parent* would otherwise trigger; it never blocks
// the consumer's own store-subscription re-render. The bug this guards against is
// about paint timing (does the stale prompt reach the screen before the publisher
// corrects itself), which only a rendered-output assertion can observe.
//
// jsdom has no real paint step, so "before paint" is approximated through React's
// own layout-vs-passive effect ordering guarantee: layout effects commit
// synchronously within the same work-loop pass, while a passive effect's work is
// queued as a separate, lower-priority task that React's Scheduler may defer to a
// later turn once the current pass has used its frame budget (verified against
// this repo's actual scheduler package: node_modules/scheduler/cjs/scheduler.development.js
// uses a 5ms frameInterval). A deliberate busy-wait in the harness's own layout
// effect burns past that budget, so the queued passive-effect task reliably gets
// deferred to the next macrotask -- awaiting exactly one macrotask afterward then
// lands between "layout effects committed" and "passive effects flushed," which is
// the real-world paint-timing gap finding 2 is about. Verified deterministic across
// 40 trials against a minimal probe before relying on it here.

import { act, render } from "@testing-library/react";
import React, {
  memo,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from "react";
import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import type { StickyLastPromptSource } from "./model";
import { useStickyLastPrompt as useStickyLastPromptNative } from "./use-sticky-last-prompt.native";
import { useStickyLastPrompt as useStickyLastPromptWeb } from "./use-sticky-last-prompt.web";

interface HookProps {
  agentId: string;
  items: readonly StreamItem[];
}

interface HookResult {
  source: StickyLastPromptSource;
}

type UseHook = (input: HookProps) => HookResult;

interface Api {
  setProps: Dispatch<SetStateAction<HookProps>>;
  result: HookResult;
}

interface ApiRef {
  current: Api | null;
}

function at(second: number): Date {
  return new Date(`2026-01-01T00:00:${second.toString().padStart(2, "0")}.000Z`);
}

function user(id: string, second: number): StreamItem {
  return { kind: "user_message", id, text: id, timestamp: at(second) };
}

function assistant(id: string, second: number): StreamItem {
  return { kind: "assistant_message", id, text: id, timestamp: at(second) };
}

// Scheduler's frame budget is 5ms; exceeding it forces shouldYieldToHost() to defer the next
// queued task (the passive-effect flush) past the current work-loop pass.
function burnPastSchedulerFrameBudget(): void {
  const start = performance.now();
  while (performance.now() - start < 10) {
    // deliberately busy-wait
  }
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Mirrors StickyPromptOverlay (view.tsx:354): subscribes to the publisher itself so a
// visibility change re-renders only this leaf, and bails out via memo when props don't change.
const Consumer = memo(function Consumer({ source }: { source: StickyLastPromptSource }) {
  const state = useSyncExternalStore(source.subscribe, source.getState);
  return <div data-testid="sticky-prompt">{state.prompt ? state.prompt.id : ""}</div>;
});

function Harness({
  useHook,
  initialProps,
  apiRef,
}: {
  useHook: UseHook;
  initialProps: HookProps;
  apiRef: ApiRef;
}) {
  const [props, setProps] = useState(initialProps);
  // Part of the same commit as the hook's own agentId-reset layout effect, so burning time here
  // pushes the Scheduler's next yield check (and thus the queued passive-effect task) past it.
  useLayoutEffect(() => {
    burnPastSchedulerFrameBudget();
  }, [props.agentId]);
  const result = useHook(props);
  apiRef.current = { setProps, result };
  return <Consumer source={result.source} />;
}

describe.each([
  ["native", useStickyLastPromptNative],
  ["web", useStickyLastPromptWeb],
])(
  "useStickyLastPrompt (%s) through a memoized useSyncExternalStore consumer",
  (_label, useHook) => {
    it("never paints the previous agent's prompt between layout-effect commit and passive-effect flush after a switch", async () => {
      const items = [user("p1", 1), assistant("a1", 2)];
      // Harness is a plain, unmemoized test harness -- there's no memo boundary for these
      // object-identity props to break.
      /* oxlint-disable react-perf/jsx-no-new-object-as-prop */
      const initialProps: HookProps = { agentId: "agent-1", items };
      const apiRef: ApiRef = { current: null };

      const { container } = render(
        <Harness useHook={useHook} initialProps={initialProps} apiRef={apiRef} />,
      );
      /* oxlint-enable react-perf/jsx-no-new-object-as-prop */
      const promptText = () =>
        container.querySelector('[data-testid="sticky-prompt"]')?.textContent;

      expect(promptText()).toBe("p1");

      // Deliberately not wrapped in act(): a plain setState call outside React's batching context
      // still defers to the Scheduler, so awaiting exactly one macrotask lands right after layout
      // effects have committed but before the (now-deferred) passive-effect flush runs -- the gap
      // a real browser's paint sits in. Items intentionally stay the same reference, isolating the
      // agentId-keyed reset from the items-driven recompute effect.
      apiRef.current?.setProps({ agentId: "agent-2", items });
      await nextMacrotask();
      expect(promptText()).toBe("");

      // Let remaining passive effects settle; the recompute effect's deps are `[items, publisher]`
      // and `items` is deliberately the same reference across the switch, so it never re-fires --
      // the agent-2 prompt stays cleared by the layout-effect reset alone. (In real usage a new
      // agentId always comes with a new `items` array too, so this stays-empty case is this
      // test's artificial isolation, not a real stuck state.)
      await act(async () => {});
      expect(promptText()).toBe("");
    });
  },
);
