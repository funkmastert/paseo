import { i18n } from "@/i18n/i18next";

/**
 * The rename sheet's plain-TypeScript form model (docs/forms.md, U9). Rename is offered only on
 * `type: project` notes and disabled while the note is dirty (the sheet's caller gates that); the
 * model itself only owns the title draft, its client-side validation, and the submission payload.
 * The authoritative collision check is the daemon's (KTD-11 rename rejects a title another
 * project already has); `setSubmitError` lets the sheet surface that after a failed submit.
 */

export interface RenameProjectFormSnapshot {
  path: string;
  currentTitle: string;
  /** Every other project's current title, for an immediate duplicate check before submitting. */
  otherProjectTitles: readonly string[];
}

export interface RenameProjectFormError {
  message: string;
}

export interface RenameProjectFormState {
  title: string;
  error: RenameProjectFormError | null;
  canSubmit: boolean;
}

export interface RenameProjectSubmission {
  path: string;
  title: string;
}

function normalize(title: string): string {
  return title.trim().toLowerCase();
}

export class RenameProjectForm {
  private readonly snapshot: RenameProjectFormSnapshot;
  private readonly listeners = new Set<() => void>();
  private title: string;
  private submitError: RenameProjectFormError | null = null;
  private state: RenameProjectFormState;

  constructor(snapshot: RenameProjectFormSnapshot) {
    this.snapshot = snapshot;
    this.title = snapshot.currentTitle;
    this.state = this.buildState();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): RenameProjectFormState => this.state;

  setTitle = (value: string): void => {
    this.title = value;
    this.submitError = null;
    this.publish();
  };

  /** The daemon rejected the submission (a collision it alone can see, or an empty title race). */
  setSubmitError = (error: RenameProjectFormError): void => {
    this.submitError = error;
    this.publish();
  };

  get submission(): RenameProjectSubmission {
    return { path: this.snapshot.path, title: this.title.trim() };
  }

  private publish(): void {
    this.state = this.buildState();
    for (const listener of this.listeners) listener();
  }

  private buildState(): RenameProjectFormState {
    const trimmed = this.title.trim();
    const error = this.validate(trimmed) ?? this.submitError;
    return {
      title: this.title,
      error,
      canSubmit:
        error === null &&
        trimmed.length > 0 &&
        normalize(trimmed) !== normalize(this.snapshot.currentTitle),
    };
  }

  private validate(trimmed: string): RenameProjectFormError | null {
    if (trimmed.length === 0) return null;
    const collides = this.snapshot.otherProjectTitles.some(
      (title) => normalize(title) === normalize(trimmed),
    );
    if (collides) return { message: i18n.t("knowledgeBase.rename.duplicateError") };
    return null;
  }
}

export function openRenameProjectForm(snapshot: RenameProjectFormSnapshot): RenameProjectForm {
  return new RenameProjectForm(snapshot);
}
