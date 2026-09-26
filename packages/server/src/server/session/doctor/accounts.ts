import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DoctorFinding } from "@getpaseo/protocol/doctor/rpc-schemas";
import { deriveClaudeProviderEntries } from "../../../services/quota-fetcher/manifest.js";
import { readClaudeAccountAuth } from "../../agent/providers/claude/account-auth.js";
import { finding, type DoctorCheck, type DoctorContext } from "./context.js";
import {
  expandPathLike,
  formatDuration,
  joinCommands,
  linkCommand,
  lstatOrNull,
  moveAsideCommand,
  realpathOrNull,
} from "./helpers.js";

/**
 * One Claude config dir a provider entry runs sessions under. Several entries can share a dir
 * (they share the login and the budget), so the slot lists every provider that uses it.
 */
export interface AccountSlot {
  configDir: string;
  providers: Array<{ id: string; label: string }>;
  keychainService?: string;
  /** The account whose `CLAUDE.md`, `projects/` and `skills/` every other slot must resolve to. */
  isCanonical: boolean;
}

export function canonicalClaudeDir(ctx: Pick<DoctorContext, "home">): string {
  return path.join(ctx.home, ".claude");
}

function providersOf(ctx: DoctorContext): Record<string, unknown> | undefined {
  const config = ctx.rawConfig;
  if (!config) return undefined;
  const agents = config["agents"];
  if (typeof agents === "object" && agents !== null) {
    const providers = (agents as Record<string, unknown>)["providers"];
    if (typeof providers === "object" && providers !== null) {
      return providers as Record<string, unknown>;
    }
  }
  const legacy = config["providers"];
  return typeof legacy === "object" && legacy !== null
    ? (legacy as Record<string, unknown>)
    : undefined;
}

export function resolveAccountSlots(ctx: DoctorContext): AccountSlot[] {
  const canonical = canonicalClaudeDir(ctx);
  const byDir = new Map<string, AccountSlot>();
  const add = (dir: string, provider: { id: string; label: string }, keychainService?: string) => {
    const configDir = path.resolve(expandPathLike(dir, ctx.home, ctx.env));
    const existing = byDir.get(configDir);
    if (existing) {
      existing.providers.push(provider);
      return;
    }
    byDir.set(configDir, {
      configDir,
      providers: [provider],
      keychainService,
      isCanonical: configDir === canonical,
    });
  };

  const derived = deriveClaudeProviderEntries(providersOf(ctx));
  for (const entry of derived) {
    add(
      entry.claudeHome,
      { id: entry.providerId, label: entry.displayName },
      entry.keychainService,
    );
  }
  if (!derived.some((entry) => entry.providerId === "claude")) {
    add(ctx.env["CLAUDE_CONFIG_DIR"] ?? canonical, { id: "claude", label: "Claude" });
  }
  return [...byDir.values()];
}

function slotName(slot: AccountSlot): string {
  return `${slot.configDir} (${slot.providers.map((p) => p.label).join(", ")})`;
}

function readFileOrNull(target: string): Buffer | null {
  try {
    return readFileSync(target);
  } catch {
    return null;
  }
}

const NO_GLOBAL_RULES =
  "Sessions on this account start without your global CLAUDE.md, so none of your standing rules apply to them.";

function checkClaudeMd(ctx: DoctorContext, slots: AccountSlot[]): DoctorFinding[] {
  const canonicalFile = path.join(canonicalClaudeDir(ctx), "CLAUDE.md");
  const canonicalReal = realpathOrNull(canonicalFile);
  const out: DoctorFinding[] = [];
  for (const slot of slots) {
    const id = "account.claude-md";
    const file = path.join(slot.configDir, "CLAUDE.md");
    const stat = lstatOrNull(file);
    const real = realpathOrNull(file);
    const name = slotName(slot);
    if (slot.isCanonical) {
      out.push(
        real
          ? finding(id, "accounts", "ok", `${name}: CLAUDE.md is the canonical file`)
          : finding(id, "accounts", "fail", `${name}: no CLAUDE.md`, {
              detail: `${file} does not exist, and every other account links to it.`,
              why: NO_GLOBAL_RULES,
              fix: `Create ${file} with your global rules, then link the other accounts to it.`,
            }),
      );
      continue;
    }
    const link = canonicalReal
      ? joinCommands(
          [
            ...(stat ? [moveAsideCommand(file, `${file}.pre-doctor`, ctx.platform)] : []),
            linkCommand(canonicalReal, file, { directory: false, platform: ctx.platform }),
          ],
          ctx.platform,
        )
      : `Create ${canonicalFile} first; every account links to it.`;
    if (!stat) {
      out.push(
        finding(id, "accounts", "fail", `${name}: no CLAUDE.md`, {
          detail: `${file} does not exist.`,
          why: NO_GLOBAL_RULES,
          fix: link,
        }),
      );
    } else if (!real) {
      out.push(
        finding(id, "accounts", "fail", `${name}: CLAUDE.md is a broken symlink`, {
          detail: `${file} points at a file that no longer exists.`,
          why: NO_GLOBAL_RULES,
          fix: link,
        }),
      );
    } else if (canonicalReal && real === canonicalReal) {
      out.push(finding(id, "accounts", "ok", `${name}: CLAUDE.md resolves to the canonical file`));
    } else {
      const same = (() => {
        const a = readFileOrNull(file);
        const b = canonicalReal ? readFileOrNull(canonicalReal) : null;
        return a !== null && b !== null && a.equals(b);
      })();
      out.push(
        finding(id, "accounts", same ? "warn" : "fail", `${name}: CLAUDE.md is a separate copy`, {
          detail: same
            ? `${file} matches ${canonicalFile} today but is its own file.`
            : `${file} differs from ${canonicalFile}.`,
          why: same
            ? "The copies drift the next time either is edited, and this account silently runs the stale one."
            : "This account runs different global rules from the canonical file.",
          fix: link,
        }),
      );
    }
  }
  return out;
}

function directoryHasEntries(dir: string): number {
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}

function checkProjectsLink(ctx: DoctorContext, slots: AccountSlot[]): DoctorFinding[] {
  const canonicalProjects = path.join(canonicalClaudeDir(ctx), "projects");
  const canonicalReal = realpathOrNull(canonicalProjects);
  const out: DoctorFinding[] = [];
  for (const slot of slots) {
    if (slot.isCanonical) continue;
    const id = "account.projects-link";
    const dir = path.join(slot.configDir, "projects");
    const name = slotName(slot);
    const stat = lstatOrNull(dir);
    const why =
      'Moving a session between accounts reads its transcript from the destination account\'s projects/; a private copy strands it ("No conversation found with session ID").';
    const relink = (existing: boolean, entries: number): string =>
      joinCommands(
        [
          ...(existing ? [moveAsideCommand(dir, `${dir}.pre-symlink`, ctx.platform)] : []),
          linkCommand(canonicalProjects, dir, { directory: true, platform: ctx.platform }),
          ...(entries > 0 && ctx.platform !== "win32"
            ? [`cp -Rn ${dir}.pre-symlink/. ${canonicalProjects}/`]
            : []),
        ],
        ctx.platform,
      );
    if (!stat) {
      out.push(
        finding(id, "accounts", "warn", `${name}: no projects/ link`, {
          detail: `${dir} does not exist yet, so the first session creates a private one.`,
          why,
          fix: relink(false, 0),
        }),
      );
      continue;
    }
    const real = realpathOrNull(dir);
    if (stat.isSymbolicLink() && real && canonicalReal && real === canonicalReal) {
      out.push(finding(id, "accounts", "ok", `${name}: projects/ is shared with ~/.claude`));
    } else if (stat.isSymbolicLink()) {
      out.push(
        finding(id, "accounts", "fail", `${name}: projects/ links somewhere else`, {
          detail: `${dir} resolves to ${real ?? "a missing target"}, not ${canonicalProjects}.`,
          why,
          fix: relink(true, 0),
        }),
      );
    } else {
      const entries = directoryHasEntries(dir);
      out.push(
        finding(
          id,
          "accounts",
          entries > 0 ? "fail" : "warn",
          `${name}: projects/ is a private directory`,
          {
            detail: `${dir} is a real directory holding ${entries} project folder(s) that ${canonicalProjects} does not have.`,
            why,
            fix: relink(true, entries),
          },
        ),
      );
    }
  }
  return out;
}

export const accountConfigCheck: DoctorCheck = {
  id: "account.config",
  category: "accounts",
  timeoutMs: 10_000,
  async run(ctx) {
    const slots = resolveAccountSlots(ctx);
    return [...checkClaudeMd(ctx, slots), ...checkProjectsLink(ctx, slots)];
  },
};

export const accountLoginCheck: DoctorCheck = {
  id: "account.login",
  category: "accounts",
  timeoutMs: 15_000,
  async run(ctx) {
    const slots = resolveAccountSlots(ctx);
    const out: DoctorFinding[] = [];
    const seenAccounts = new Map<string, AccountSlot>();
    for (const slot of slots) {
      const id = "account.login";
      const name = slotName(slot);
      const auth = readClaudeAccountAuth(slot.configDir);
      const credentials = await ctx.probes.hasCredentials({
        configDir: slot.configDir,
        providerId: slot.providers[0]?.id ?? "claude",
        keychainService: slot.keychainService,
      });
      const signIn = `CLAUDE_CONFIG_DIR=${slot.configDir} claude /login`;
      if (auth.state === "signed-out" || credentials === false) {
        out.push(
          finding(id, "accounts", "fail", `${name}: not logged in`, {
            detail:
              auth.state === "signed-out"
                ? `${path.join(slot.configDir, ".claude.json")} has no oauthAccount.`
                : "No credential is stored for this config dir.",
            why: "Every session routed to this account fails at start, and the pool keeps routing to it until it is capped out.",
            fix: signIn,
          }),
        );
        continue;
      }
      if (auth.state === "unknown") {
        out.push(
          finding(id, "accounts", "warn", `${name}: login state unknown`, {
            detail: `${path.join(slot.configDir, ".claude.json")} is missing or unreadable, so the CLI has never signed in here.`,
            why: "Sessions on this account would start logged out.",
            fix: signIn,
          }),
        );
        continue;
      }
      const label = auth.accountLabel;
      const twin = label ? seenAccounts.get(label) : undefined;
      if (label && twin) {
        out.push(
          finding(id, "accounts", "warn", `${name}: same login as ${twin.configDir}`, {
            detail: "Two config dirs are signed into one account.",
            why: "The pool counts two accounts but has one budget, so 'failing over' between them moves work nowhere.",
            fix: `CLAUDE_CONFIG_DIR=${slot.configDir} claude /login   # sign in as a different account`,
          }),
        );
        continue;
      }
      if (label) seenAccounts.set(label, slot);
      out.push(
        finding(id, "accounts", "ok", `${name}: logged in`, {
          detail:
            credentials === null
              ? "Credential presence could not be checked on this platform."
              : undefined,
        }),
      );
    }
    return out;
  },
};

const DRAINED_PCT = 90;
const CAPPED_PCT = 100;

export const accountBudgetCheck: DoctorCheck = {
  id: "account.budget",
  category: "accounts",
  timeoutMs: 20_000,
  async run(ctx) {
    const usage = ctx.facts.usage;
    if (!usage) {
      return [
        finding("account.budget", "accounts", "skip", "Usage windows were not available", {
          detail: "The daemon did not return provider usage.",
        }),
      ];
    }
    const claudeSlots = new Set(
      resolveAccountSlots(ctx).flatMap((slot) => slot.providers.map((p) => p.id)),
    );
    const out: DoctorFinding[] = [];
    for (const provider of usage) {
      if (!claudeSlots.has(provider.providerId)) continue;
      const id = "account.budget";
      const name = provider.displayName;
      if (provider.status !== "available") {
        out.push(
          finding(id, "accounts", "warn", `${name}: usage unreadable`, {
            detail: provider.error ?? `Usage status is ${provider.status}.`,
            why: "The pool cannot see this account's headroom, so it routes to it blind.",
          }),
        );
        continue;
      }
      const hot = provider.windows
        .filter((window) => typeof window.usedPct === "number" && window.usedPct >= DRAINED_PCT)
        .sort((a, b) => (b.usedPct ?? 0) - (a.usedPct ?? 0));
      if (hot.length === 0) {
        const worst = Math.max(0, ...provider.windows.map((w) => w.usedPct ?? 0));
        out.push(
          finding(
            id,
            "accounts",
            "ok",
            `${name}: budget healthy (worst window ${Math.round(worst)}% used)`,
          ),
        );
        continue;
      }
      const capped = hot.some((window) => (window.usedPct ?? 0) >= CAPPED_PCT);
      const parts = hot.map((window) => {
        const resets = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
        const eta = Number.isFinite(resets)
          ? `, resets in ${formatDuration(resets - ctx.now())}`
          : "";
        return `${window.label} ${Math.round(window.usedPct ?? 0)}%${eta}`;
      });
      out.push(
        finding(
          id,
          "accounts",
          capped ? "fail" : "warn",
          `${name}: ${capped ? "out of budget" : "near cap"} (${parts.join("; ")})`,
          {
            why: capped
              ? "Sessions on this account are refused until the window resets."
              : "Work routed here will hit the cap soon and have to fail over mid-task.",
            fix: "paseo provider ls   # then route new work to another account until the window resets",
          },
        ),
      );
    }
    if (out.length === 0) {
      out.push(finding("account.budget", "accounts", "skip", "No Claude account reported usage"));
    }
    return out;
  },
};
