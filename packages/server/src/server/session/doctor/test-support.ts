import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildDoctorContext } from "./facts.js";
import type { DoctorContext, DoctorFacts, DoctorProbes } from "./context.js";

export interface Fixture {
  home: string;
  paseoHome: string;
}

/** A throwaway HOME with a canonical `~/.claude` (CLAUDE.md, projects/, skills/) and a paseo home. */
export function makeFixture(): Fixture {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "doctor-test-")));
  const paseoHome = path.join(home, ".paseo");
  mkdirSync(paseoHome, { recursive: true });
  mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "# global rules\n");
  return { home, paseoHome };
}

export function writeConfig(fixture: Fixture, config: unknown): void {
  writeFileSync(path.join(fixture.paseoHome, "config.json"), JSON.stringify(config, null, 2));
}

/** Two extra Claude accounts as an account pool declares them. */
export function poolConfig(
  fixture: Fixture,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    agents: {
      providers: {
        claude: {
          label: "Leader",
          env: { CLAUDE_CONFIG_DIR: path.join(fixture.home, ".claude-leader") },
        },
        "claude-personal": {
          extends: "claude",
          label: "Worker",
          env: { CLAUDE_CONFIG_DIR: path.join(fixture.home, ".claude-personal") },
        },
        "claude-backup": {
          extends: "claude",
          label: "Backup",
          env: { CLAUDE_CONFIG_DIR: path.join(fixture.home, ".claude") },
        },
      },
    },
    ...extra,
  };
}

export function makeAccountDir(
  dir: string,
  options: { signedIn?: boolean | null; email?: string } = {},
): void {
  mkdirSync(dir, { recursive: true });
  if (options.signedIn === null) return;
  writeFileSync(
    path.join(dir, ".claude.json"),
    JSON.stringify(
      options.signedIn === false
        ? {}
        : { oauthAccount: { emailAddress: options.email ?? `${path.basename(dir)}@example.com` } },
    ),
  );
}

export function fakeProbes(overrides: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    statfs: async () => ({ freeBytes: 200 * 1024 ** 3, totalBytes: 900 * 1024 ** 3 }),
    measureDirBytes: async () => 1024 ** 3,
    hasCredentials: async () => true,
    ...overrides,
  };
}

export function makeContext(
  fixture: Fixture,
  facts: Partial<DoctorFacts> = {},
  extra: {
    probes?: DoctorProbes;
    deep?: boolean;
    now?: () => number;
    platform?: NodeJS.Platform;
  } = {},
): DoctorContext {
  return buildDoctorContext({
    home: fixture.home,
    paseoHome: fixture.paseoHome,
    platform: extra.platform ?? "darwin",
    env: {},
    deep: extra.deep,
    now: extra.now,
    probes: extra.probes ?? fakeProbes(),
    facts: {
      source: "daemon",
      daemon: { version: "0.8.0", startedAt: new Date().toISOString(), pid: 1, execPath: null },
      plugins: [],
      agents: [],
      workspaces: [],
      usage: [],
      ...facts,
    },
  });
}

/** Path → content hash (or link target) for everything under `root`, to prove nothing changed. */
export function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) out[full] = `-> ${readlinkSync(full)}`;
      else if (stat.isDirectory()) {
        out[full] = "dir";
        walk(full);
      } else
        out[full] =
          createHash("sha256").update(readFileSync(full)).digest("hex") + `@${stat.mtimeMs}`;
    }
  };
  walk(root);
  return out;
}

export function link(target: string, at: string): void {
  symlinkSync(target, at);
}
