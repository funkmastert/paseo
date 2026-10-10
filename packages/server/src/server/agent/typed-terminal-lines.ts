import { isIncompleteShellInput } from "./shell-commands.js";

const MAX_TYPED_LINE_CHARS = 64 * 1024;
const MAX_PENDING_LINES = 50;
const MAX_TRACKED_TERMINALS = 256;

interface TypedLineState {
  line: string;
  /** False once a key only the shell can interpret (Tab, an arrow, Ctrl-A) edits the line. */
  reliable: boolean;
  /** Submitted lines of a script the shell is still reading (an open heredoc or quote). */
  pending: string[];
}

export type TypedLineSnapshot = TypedLineState | null;

/**
 * Rebuilds, from the keys an agent sends to a terminal, the scripts the shell will run. A line
 * counts once it is submitted: Enter, or Ctrl-D ending a heredoc. A line edited by a key only
 * the shell understands is dropped rather than guessed at.
 */
export class TypedTerminalLines {
  private readonly terminals = new Map<string, TypedLineState>();

  feed(terminalId: string, data: string): string[] {
    const state = this.stateFor(terminalId);
    const submitted: string[] = [];
    let previous = "";
    for (const char of data) {
      const afterReturn = previous === "\r";
      previous = char;
      if (char === "\n" && afterReturn) continue;
      if (char === "\r" || char === "\n") {
        submitLine(state, submitted);
      } else if (char === "\u0003") {
        // Ctrl-C drops the line and any heredoc the shell was reading.
        Object.assign(state, emptyTypedLineState());
      } else if (char === "\u0015") {
        state.line = "";
        state.reliable = true;
      } else if (char === "\u0004") {
        if (state.line === "" && state.pending.length > 0) {
          // Ctrl-D on an empty line ends an open heredoc, and the shell runs what it has.
          submitted.push(state.pending.join("\n"));
          state.pending = [];
        } else if (state.line !== "") {
          state.reliable = false;
        }
      } else if (char === "\u007f" || char === "\b") {
        state.line = state.line.slice(0, -1);
      } else if (char < " ") {
        state.reliable = false;
      } else if (state.line.length < MAX_TYPED_LINE_CHARS) {
        state.line += char;
      } else {
        state.reliable = false;
      }
    }
    return submitted;
  }

  snapshot(terminalId: string): TypedLineSnapshot {
    const state = this.terminals.get(terminalId);
    return state ? { ...state, pending: [...state.pending] } : null;
  }

  /** Puts a terminal back to a snapshot, e.g. when the input that followed it was refused. */
  restore(terminalId: string, snapshot: TypedLineSnapshot): void {
    if (snapshot) {
      this.terminals.set(terminalId, { ...snapshot, pending: [...snapshot.pending] });
    } else {
      this.terminals.delete(terminalId);
    }
  }

  forget(terminalId: string): void {
    this.terminals.delete(terminalId);
  }

  private stateFor(terminalId: string): TypedLineState {
    const existing = this.terminals.get(terminalId);
    if (existing) return existing;
    if (this.terminals.size >= MAX_TRACKED_TERMINALS) {
      const oldest = this.terminals.keys().next().value;
      if (oldest !== undefined) this.terminals.delete(oldest);
    }
    const created = emptyTypedLineState();
    this.terminals.set(terminalId, created);
    return created;
  }
}

function emptyTypedLineState(): TypedLineState {
  return { line: "", reliable: true, pending: [] };
}

function submitLine(state: TypedLineState, submitted: string[]): void {
  const { line, reliable } = state;
  state.line = "";
  state.reliable = true;
  if (!reliable) {
    // Whether the unknown line opened or closed a heredoc is unknowable too.
    state.pending = [];
    return;
  }
  const script = [...state.pending, line].join("\n");
  if (isIncompleteShellInput(script) && state.pending.length < MAX_PENDING_LINES) {
    state.pending.push(line);
    return;
  }
  state.pending = [];
  if (script.trim() !== "") submitted.push(script);
}
