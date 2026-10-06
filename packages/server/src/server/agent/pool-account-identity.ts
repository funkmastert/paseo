import { accountKeyOf } from "./account-pool-providers.js";
import type { AgentAccountAuth } from "./agent-sdk-types.js";
import { claudeSignInCommand } from "./providers/claude/account-auth.js";

/**
 * Two pool entries that are one login, or an entry signed into a login other than the one it
 * declares. Both leave the pool counting accounts it does not have, so failover between them
 * moves work nowhere and a budget reads as two when it is one.
 *
 * `shared-login` means two config dirs report the same account id (or email, when there is no id).
 * One member is the keeper and is not flagged: the one whose declared email matches the login, else
 * the leader, else the first by provider id. The others are flagged, and their fix is to sign in as
 * their own account.
 */
export type PoolAccountIdentityKind = "shared-login" | "wrong-login";

export interface PoolAccountIdentityProblem {
  providerId: string;
  kind: PoolAccountIdentityKind;
  /** The email the config dir is actually signed into. */
  signedInEmail: string | null;
  /** The email the entry declares, when it declares one. */
  expectedEmail: string | null;
  /** Other entries on the same login. Empty for `wrong-login`. */
  sharesWith: string[];
  /** One line for a person: what is wrong and on which login. */
  summary: string;
  /** The command that signs this config dir in as its own account. */
  fixCommand: string;
}

export interface PoolAccountReading {
  providerId: string;
  role?: "leader" | "worker" | null;
  /** The directory the sign-in command targets. Null leaves the command unscoped. */
  configDir: string | null;
  expectedEmail: string | null;
  auth: AgentAccountAuth | null;
}

function sameEmail(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function fixFor(reading: PoolAccountReading): string {
  if (reading.configDir) return claudeSignInCommand(reading.configDir, reading.expectedEmail);
  return reading.expectedEmail
    ? `claude auth login --email ${reading.expectedEmail}`
    : "claude /login";
}

/** The members of one login that are not the keeper, each as a problem. */
function sharedLoginProblems(members: readonly PoolAccountReading[]): PoolAccountIdentityProblem[] {
  const signedIn = members.find((m) => m.auth?.state === "signed-in")?.auth;
  const login = signedIn?.state === "signed-in" ? signedIn.accountLabel : null;
  const sorted = [...members].sort((a, b) => a.providerId.localeCompare(b.providerId));
  const keeper =
    sorted.find(
      (m) => login !== null && m.expectedEmail !== null && sameEmail(m.expectedEmail, login),
    ) ??
    sorted.find((m) => m.role === "leader") ??
    sorted[0];
  const ids = sorted.map((m) => m.providerId);
  return sorted
    .filter((member) => member !== keeper)
    .map((member) => {
      const sharesWith = ids.filter((id) => id !== member.providerId);
      return {
        providerId: member.providerId,
        kind: "shared-login",
        signedInEmail: login,
        expectedEmail: member.expectedEmail,
        sharesWith,
        summary: `${member.providerId} is signed into ${login ?? "a login"}, the same login as ${sharesWith.join(", ")}`,
        fixCommand: fixFor(member),
      };
    });
}

function wrongLoginProblem(reading: PoolAccountReading): PoolAccountIdentityProblem | null {
  if (reading.auth?.state !== "signed-in" || !reading.auth.accountLabel) return null;
  const signedInEmail = reading.auth.accountLabel;
  if (!reading.expectedEmail || sameEmail(reading.expectedEmail, signedInEmail)) return null;
  return {
    providerId: reading.providerId,
    kind: "wrong-login",
    signedInEmail,
    expectedEmail: reading.expectedEmail,
    sharesWith: [],
    summary: `${reading.providerId} is signed into ${signedInEmail}, not ${reading.expectedEmail}`,
    fixCommand: fixFor(reading),
  };
}

/** Every flagged entry in the pool, as of this reading. Nothing here touches the network or disk. */
export function findPoolAccountIdentityProblems(
  readings: readonly PoolAccountReading[],
): PoolAccountIdentityProblem[] {
  const groups = new Map<string, PoolAccountReading[]>();
  for (const reading of readings) {
    const key = accountKeyOf(reading.auth);
    if (key === null) continue;
    const group = groups.get(key);
    if (group) group.push(reading);
    else groups.set(key, [reading]);
  }

  const shared = [...groups.values()]
    .filter((members) => members.length > 1)
    .flatMap(sharedLoginProblems);
  const flagged = new Set(shared.map((problem) => problem.providerId));
  const wrong = readings
    .filter((reading) => !flagged.has(reading.providerId))
    .map(wrongLoginProblem)
    .filter((problem): problem is PoolAccountIdentityProblem => problem !== null);
  return [...shared, ...wrong].sort((a, b) => a.providerId.localeCompare(b.providerId));
}

/**
 * Standing problems from the last sweep. A problem is an episode: it is raised once when a provider
 * first gets one, stays quiet while it stands, and is forgotten when a sweep no longer finds it, so
 * the next occurrence is raised again.
 */
export class PoolAccountIdentityTracker {
  private standing = new Map<string, PoolAccountIdentityProblem>();

  /** Replaces the standing set; returns the problems that were not standing before. */
  observe(problems: readonly PoolAccountIdentityProblem[]): PoolAccountIdentityProblem[] {
    const raised = problems.filter((problem) => !this.standing.has(problem.providerId));
    this.standing = new Map(problems.map((problem) => [problem.providerId, problem]));
    return raised;
  }

  problemFor(providerId: string): PoolAccountIdentityProblem | null {
    return this.standing.get(providerId) ?? null;
  }
}
