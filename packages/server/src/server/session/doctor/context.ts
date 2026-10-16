import type { DoctorFinding, DoctorFindingStatus } from "@getpaseo/protocol/doctor/rpc-schemas";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import type { RunGitCommand } from "../../../utils/run-git-command.js";

/**
 * Everything a doctor check may look at. Checks read this and the filesystem; nothing here
 * mutates. The daemon fills `facts` from live state, the CLI fills it from existing RPCs when the
 * daemon predates `daemon.doctor.request`, and tests fill it with fixtures and a temp `home`.
 */
export interface DoctorContext {
  home: string;
  paseoHome: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  now: () => number;
  /** A long budget for the worktree sweep instead of the quick one. */
  deep: boolean;
  /** Parsed `config.json`; null when the file is absent or is not valid JSON. */
  rawConfig: Record<string, unknown> | null;
  /** Why `rawConfig` is null, when it is. */
  rawConfigError: string | null;
  facts: DoctorFacts;
  probes: DoctorProbes;
}

export interface DoctorPluginFact {
  id: string;
  path: string;
  enabled: boolean;
  status: "running" | "disabled" | "failed";
  error?: string;
}

export interface DoctorAgentFact {
  cwd: string;
  /** Lifecycle: initializing | idle | running | error | closed. */
  status: string;
  archived: boolean;
}

export interface DoctorWorkspaceFact {
  cwd: string;
  baseBranch: string | null;
  archivedAt: string | null;
  pinned: boolean;
}

export interface DoctorConfigIssue {
  path: string;
  message: string;
  /** Set for `.strict()` violations: the key the running code does not know. */
  unknownKey?: string;
}

export interface DoctorFacts {
  /** Where the facts came from. `cli` means the running daemon could not answer for itself. */
  source: "daemon" | "cli";
  /** Null when no daemon answered. */
  daemon: {
    version: string | null;
    startedAt: string | null;
    pid: number | null;
    /** The node/Electron binary the daemon runs on; names the app bundle it came from. */
    execPath: string | null;
  } | null;
  /** Null when unknown. An empty array means "no plugins". */
  plugins: DoctorPluginFact[] | null;
  pluginLogs?: (id: string) => string[];
  agents: DoctorAgentFact[] | null;
  workspaces: DoctorWorkspaceFact[] | null;
  usage: ProviderUsage[] | null;
  /**
   * The config schema to validate `config.json` with, and whose it is. In the daemon this is the
   * running code; in the CLI fallback it is the CLI's own build, which may know keys the daemon
   * does not.
   */
  validateConfig: (raw: unknown) => DoctorConfigIssue[];
  configSchemaOwner: "the running daemon" | "this CLI build";
  /** The bundled skills selection (`agents.skills.selection`); undefined means the default. */
  loadSkillsStatus?: () => Promise<{
    ops: Array<{ kind: "add" | "update" | "delete"; name: string }>;
  }>;
}

export interface DoctorProbes {
  statfs(path: string): Promise<{ freeBytes: number; totalBytes: number }>;
  /** Bytes under `path`, or null when it could not be measured before `deadline` (epoch ms). */
  measureDirBytes(path: string, deadline: number): Promise<number | null>;
  /** True when a credential for this account is present. Presence only; never reads a secret. */
  hasCredentials(input: {
    configDir: string;
    providerId: string;
    keychainService?: string;
  }): Promise<boolean | null>;
  runGit?: RunGitCommand;
  /**
   * Runs one program with a hard timeout and returns what it printed, or null when it could not
   * start or timed out. The token audit uses it for `claude -p /context`, `launchctl print`,
   * `plutil` and `ps`; tests fake it with recorded output.
   */
  exec(
    file: string,
    args: readonly string[],
    options: { timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv },
  ): Promise<{ stdout: string; stderr: string; code: number | null } | null>;
}

export interface DoctorCheck {
  id: string;
  category: string;
  /** This check's own deadline. One slow check never delays or fails the others. */
  timeoutMs: number | ((ctx: DoctorContext) => number);
  run(ctx: DoctorContext, deadline: number): Promise<DoctorFinding[]>;
}

export function finding(
  id: string,
  category: string,
  status: DoctorFindingStatus,
  title: string,
  extra: Partial<Pick<DoctorFinding, "detail" | "why" | "fix">> = {},
): DoctorFinding {
  return { id, category, status, title, ...extra };
}
