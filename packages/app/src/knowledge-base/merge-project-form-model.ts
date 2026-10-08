import type { KnowledgeBaseMergeCounts } from "@getpaseo/protocol/knowledge-base/rpc-schemas";

/**
 * The merge sheet's plain-TypeScript form model (docs/forms.md, U9). Three steps: pick the
 * target, review the dry-run counts, confirm. The model owns navigation between those steps and
 * which counts to show; the async dry-run and the real merge RPC calls, and the destructive
 * `confirmDialog`, live in the sheet component (same split as `ProjectEditSheet`'s `useMutation`
 * around a plain model).
 */

export interface MergeProjectCandidate {
  path: string;
  permalink: string;
  title: string;
}

export type MergeProjectFormStep =
  | { kind: "pick" }
  | { kind: "counting"; target: MergeProjectCandidate }
  | { kind: "ready"; target: MergeProjectCandidate; counts: KnowledgeBaseMergeCounts }
  | { kind: "error"; target: MergeProjectCandidate; message: string }
  | { kind: "merging"; target: MergeProjectCandidate; counts: KnowledgeBaseMergeCounts }
  | {
      kind: "mergeFailed";
      target: MergeProjectCandidate;
      counts: KnowledgeBaseMergeCounts;
      message: string;
    };

export interface MergeProjectFormSnapshot {
  source: MergeProjectCandidate;
  /** Every other project; the source never appears (KTD-11 rejects merging a project into itself). */
  candidates: readonly MergeProjectCandidate[];
}

export interface MergeProjectFormState {
  source: MergeProjectCandidate;
  candidates: readonly MergeProjectCandidate[];
  step: MergeProjectFormStep;
  canConfirm: boolean;
}

export class MergeProjectForm {
  private readonly snapshot: MergeProjectFormSnapshot;
  private readonly listeners = new Set<() => void>();
  private step: MergeProjectFormStep = { kind: "pick" };
  private state: MergeProjectFormState;

  constructor(snapshot: MergeProjectFormSnapshot) {
    this.snapshot = snapshot;
    this.state = this.buildState();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): MergeProjectFormState => this.state;

  /**
   * Picking a target starts the dry run; the caller awaits it and reports back. A target equal to
   * the source is a no-op: the candidate list never offers it, but a defensive check here means
   * the model itself refuses a self-merge rather than trusting every caller to filter it out.
   */
  pickTarget = (target: MergeProjectCandidate): void => {
    if (target.path === this.snapshot.source.path) return;
    this.step = { kind: "counting", target };
    this.publish();
  };

  back = (): void => {
    this.step = { kind: "pick" };
    this.publish();
  };

  receiveDryRun = (counts: KnowledgeBaseMergeCounts): void => {
    if (this.step.kind !== "counting") return;
    this.step = { kind: "ready", target: this.step.target, counts };
    this.publish();
  };

  receiveDryRunError = (message: string): void => {
    if (this.step.kind !== "counting") return;
    this.step = { kind: "error", target: this.step.target, message };
    this.publish();
  };

  startMerging = (): void => {
    if (this.step.kind !== "ready") return;
    this.step = { kind: "merging", target: this.step.target, counts: this.step.counts };
    this.publish();
  };

  receiveMergeError = (message: string): void => {
    if (this.step.kind !== "merging") return;
    this.step = {
      kind: "mergeFailed",
      target: this.step.target,
      counts: this.step.counts,
      message,
    };
    this.publish();
  };

  get sourcePath(): string {
    return this.snapshot.source.path;
  }

  private publish(): void {
    this.state = this.buildState();
    for (const listener of this.listeners) listener();
  }

  private buildState(): MergeProjectFormState {
    return {
      source: this.snapshot.source,
      candidates: this.snapshot.candidates,
      step: this.step,
      canConfirm: this.step.kind === "ready",
    };
  }
}

export function openMergeProjectForm(snapshot: MergeProjectFormSnapshot): MergeProjectForm {
  return new MergeProjectForm(snapshot);
}
