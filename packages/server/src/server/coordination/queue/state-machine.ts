import {
  CLOSURE_REASONS_REQUIRING_TARGET,
  OPEN_WORK_ITEM_STATES,
  WORK_ITEM_CLOSURE_REASONS,
  type WorkItemClosure,
  type WorkItemState,
} from "@getpaseo/protocol/coordination/queue-schemas";

// Input validation for the queue API. Messages teach the caller (often an agent) what to send
// instead, because the caller acts on the message and nothing else. See docs/work-queue.md.
export class QueueValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueValidationError";
  }
}

const TERMINAL_TARGETS: readonly WorkItemState[] = [
  "done",
  "failed",
  "denied",
  "canceled",
  "handed-off",
];

// Every open state can reach every other open state and every terminal state. Terminal states
// go nowhere: a reopened item would hide that its work was once declared finished.
const LEGAL_TRANSITIONS: Record<WorkItemState, readonly WorkItemState[]> = {
  pending: ["in-progress", "blocked", ...TERMINAL_TARGETS],
  "in-progress": ["pending", "blocked", ...TERMINAL_TARGETS],
  blocked: ["pending", "in-progress", ...TERMINAL_TARGETS],
  done: [],
  failed: [],
  denied: [],
  canceled: [],
  "handed-off": [],
};

export function isOpenState(state: WorkItemState): boolean {
  return OPEN_WORK_ITEM_STATES.includes(state);
}

export function isLegalTransition(from: WorkItemState, to: WorkItemState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function validateClosure(closure: WorkItemClosure): void {
  if (!WORK_ITEM_CLOSURE_REASONS.includes(closure.reason)) {
    throw new QueueValidationError(
      `Unknown closure reason "${closure.reason}". Use one of: ${WORK_ITEM_CLOSURE_REASONS.join(", ")}.`,
    );
  }
  if (CLOSURE_REASONS_REQUIRING_TARGET.includes(closure.reason) && !closure.target?.trim()) {
    throw new QueueValidationError(
      `Closure reason "${closure.reason}" needs a target that says where the work went ` +
        `(an agent id, "human", or an item id). Reasons that need a target: ` +
        `${CLOSURE_REASONS_REQUIRING_TARGET.join(", ")}.`,
    );
  }
}

export interface TransitionRequest {
  from: WorkItemState;
  to: WorkItemState;
  closure?: WorkItemClosure;
}

// `handoff` passes `viaHandoff` because it is the only way into `handed-off`: the store must
// create the successor in the same commit.
export function validateTransition(
  request: TransitionRequest,
  options?: { viaHandoff?: boolean },
): void {
  const { from, to, closure } = request;
  if (!isOpenState(from)) {
    throw new QueueValidationError(
      `This item is already ${from} and cannot move again. Create a new item for follow-on work.`,
    );
  }
  if (from === to) {
    throw new QueueValidationError(`This item is already ${from}.`);
  }
  if (!isLegalTransition(from, to)) {
    throw new QueueValidationError(`An item cannot move from ${from} to ${to}.`);
  }
  if (to === "handed-off" && !options?.viaHandoff) {
    throw new QueueValidationError(
      `Use handoff to hand an item to another owner. It closes this item and creates the ` +
        `successor together, so the work cannot be dropped in between.`,
    );
  }
  if (closure) validateClosure(closure);

  if (to === "done" && !closure) {
    throw new QueueValidationError(
      `Finishing an item as done needs a closure reason that says what happens to the work next: ` +
        `${WORK_ITEM_CLOSURE_REASONS.join(", ")}. Use no-follow-on when nothing follows.`,
    );
  }
  if (to === "blocked" && closure?.reason !== "blocked_on") {
    throw new QueueValidationError(
      `Blocking an item needs closure reason blocked_on with a target naming what it waits on ` +
        `(an agent id, "human", or an item id).`,
    );
  }
  if (closure && isOpenState(to) && to !== "blocked") {
    throw new QueueValidationError(
      `A closure only applies when an item closes or blocks. Moving to ${to} takes no closure.`,
    );
  }
}
