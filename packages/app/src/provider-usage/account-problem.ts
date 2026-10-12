import type { ProviderUsage } from "./types";

export type AccountProblemKind = "signed_out" | "identity";

/** A sign-in or identity problem the daemon reports on a usage row: its words and its fix. */
export interface AccountProblem {
  kind: AccountProblemKind;
  summary: string;
  fixCommand: string;
  /** Only ever true for `signed_out`: the daemon can start the login itself. */
  canSignIn: boolean;
}

/**
 * The one problem a usage row shows. A signed-out account wins over an identity problem on the
 * same row: it is dead to failover whichever login it is signed into, and an amber identity line
 * beside the red one would bury the fix that matters (docs/account-failover.md).
 */
export function resolveAccountProblem(
  usage: Pick<ProviderUsage, "accountAuth" | "accountIdentity">,
): AccountProblem | null {
  const { accountAuth, accountIdentity } = usage;
  if (accountAuth) {
    return {
      kind: "signed_out",
      summary: accountAuth.summary,
      fixCommand: accountAuth.fixCommand,
      canSignIn: accountAuth.canSignIn,
    };
  }
  if (accountIdentity) {
    return {
      kind: "identity",
      summary: accountIdentity.summary,
      fixCommand: accountIdentity.fixCommand,
      canSignIn: false,
    };
  }
  return null;
}
