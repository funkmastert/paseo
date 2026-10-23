/**
 * How long a started login keeps the button pending. Mirrors the daemon's login slot
 * (LOGIN_TIMEOUT_MS in claude-account-sign-in.ts): until it frees, a retry only gets
 * `already_running`, so the button stays pending that long, win or lose.
 */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/**
 * One banner row's Sign in button: idle, waiting on the login, or showing why it failed. A failure
 * with a null message had nothing better to say than the generic copy.
 */
export type SignInState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "failed"; message: string | null };

export type SignInEvent =
  | { type: "start" }
  /** The daemon started the login, or one was already running: wait out SIGN_IN_TIMEOUT_MS. */
  | { type: "started" }
  /** The daemon refused to start the login, with its own `error` when it gave one. */
  | { type: "failed"; error: string | null }
  /** The request itself failed: the host disconnected, or the RPC timed out. */
  | { type: "threw"; error: unknown }
  | { type: "timed_out" };

export const SIGN_IN_IDLE: SignInState = { status: "idle" };

export function signInReducer(state: SignInState, event: SignInEvent): SignInState {
  switch (event.type) {
    case "start":
      return state.status === "pending" ? state : { status: "pending" };
    case "started":
      return state;
    case "failed":
      return { status: "failed", message: event.error };
    case "threw":
      return {
        status: "failed",
        message: event.error instanceof Error ? event.error.message : null,
      };
    case "timed_out":
      return state.status === "pending" ? SIGN_IN_IDLE : state;
  }
}
