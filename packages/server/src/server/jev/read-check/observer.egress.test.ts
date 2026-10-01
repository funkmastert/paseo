import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { resolveJevConfig } from "../config.js";
import type {
  JevNotAskedReason,
  JevOutcome,
  JevSavingsSink,
  JevSavingsValidation,
} from "../contract.js";
import { createTestJevService } from "../fake.js";
import { isSecretShapedPath, SECRET_PATHSPEC_GLOBS } from "../secret-paths.js";
import { ReadCheckObserver } from "./observer.js";

/**
 * The adversarial review's probes (feature 16, "Blockers: data egress", M1–M3), as tests. Each
 * case puts a marker in a file that must never be sent and checks the bytes the fake transport
 * received, which is the redacted body that would leave the machine.
 */

const SECRET = "plainpw_Zq81vN3mKt7";

let root: string;
let home: string;
let repo: string;
let paseoHome: string;
let toolUseCounter = 0;

function pad(marker: string): string {
  const lines = [marker];
  for (let index = 0; index < 400; index += 1) {
    lines.push(`  const value${index} = computeSomethingUseful(${index}, "padding");`);
  }
  return `${lines.join("\n")}\n`;
}

function write(base: string, relative: string, content: string): string {
  const full = path.join(base, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

interface Harness {
  observer: ReadCheckObserver;
  jev: ReturnType<typeof createTestJevService>;
  notAsked: JevNotAskedReason[];
  validations: JevSavingsValidation[];
  sent: () => string;
}

function setup(options: { cwd?: string; config?: Record<string, unknown> } = {}): Harness {
  const cwd = options.cwd ?? repo;
  const config = options.config ?? {};
  const jev = createTestJevService({
    paseoHome,
    homeDir: home,
    config,
    answers: { need: { type: "choice", choice: "not_needed", confidence: 0.91 } },
    service: { resolveAgentCwds: async () => [cwd] },
  });
  const notAsked: JevNotAskedReason[] = [];
  const validations: JevSavingsValidation[] = [];
  let records = 0;
  const savings: JevSavingsSink = {
    record: () => `sv_${++records}`,
    settle: () => undefined,
    validate: (_id, validation) => validations.push(validation),
    countNotAsked: (_feature, reason) => notAsked.push(reason),
    noteRead: () => undefined,
  };
  const resolved = resolveJevConfig(config, { homeDir: home });
  const observer = new ReadCheckObserver({
    jev,
    savings,
    readConfig: () => resolved.readCheck,
    agents: {
      agent: () => ({
        title: "t",
        cwd,
        model: "claude-opus-5-5",
        workspaceId: "w",
        labels: {},
        contextTokens: 1,
      }),
      assignment: () => "a",
      tail: () => ({ epoch: "e", rows: [] }),
      after: () => ({ epoch: "e", rows: [] }),
    },
    homeDir: home,
    paseoHome,
    logger: pino({ level: "silent" }),
    sweepIntervalMs: 0,
  });
  return {
    observer,
    jev,
    notAsked,
    validations,
    sent: () => JSON.stringify(jev.transport.calls),
  };
}

function readEvent(cwd: string, filePath: string, content: string) {
  const lines = content.split("\n").length - 1;
  return {
    agentId: "a1",
    agentCwd: cwd,
    input: {
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: filePath },
      tool_use_id: `t${++toolUseCounter}`,
      cwd,
      tool_response: {
        type: "text",
        file: { filePath, content, numLines: lines, startLine: 1, totalLines: lines },
      },
    },
  };
}

function bashEvent(cwd: string, command: string, stdout: string) {
  return {
    agentId: "a1",
    agentCwd: cwd,
    input: {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command },
      tool_use_id: `t${++toolUseCounter}`,
      cwd,
      tool_response: { stdout, stderr: "", interrupted: false },
    },
  };
}

async function readCase(filePath: string, content: string, cwd = repo): Promise<Harness> {
  const harness = setup({ cwd });
  harness.observer.postToolUse(readEvent(cwd, filePath, content));
  await harness.observer.idle();
  return harness;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "read-check-egress-")));
  home = path.join(root, "home");
  repo = path.join(home, "projects", "app");
  paseoHome = path.join(home, ".paseo");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  mkdirSync(paseoHome, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("baseline: an ordinary file in the repo is sent, so every refusal below is the rule's", async () => {
  const file = write(repo, "README.md", pad(`# readme ${SECRET}`));
  const { jev, sent } = await readCase(file, pad(`# readme ${SECRET}`));
  expect(jev.transport.calls).toHaveLength(1);
  expect(sent()).toContain(SECRET);
});

describe("B1: a Bash line that can read anything besides one file is never judged", () => {
  const stdout = `note ${SECRET}\n${pad("# readme")}`;
  test.each([
    "cat README.md; cat < .env",
    "cat README.md - < .env",
    "cat README.md 0<.env",
    'head -100 README.md && cat <<< "$TOKEN"',
    "cat README.md /dev/stdin < .env",
    "cat .env | cat README.md -",
    "cat README.md <<EOF\nsecret\nEOF",
    "cat README.md docs/other.md",
  ])("%s", async (command) => {
    write(repo, "README.md", pad("# readme"));
    write(repo, "docs/other.md", pad("# other"));
    write(repo, ".env", `TOKEN=${SECRET}\n`);
    const { observer, jev, notAsked, sent } = setup();
    observer.postToolUse(bashEvent(repo, command, stdout));
    await observer.idle();
    expect(jev.transport.calls).toEqual([]);
    expect(sent()).not.toContain(SECRET);
    expect(notAsked).toEqual(["compound"]);
  });

  test("a plain Bash read sends the file as it is on disk, never the command's output", async () => {
    write(repo, "README.md", pad("# readme"));
    const { observer, jev, sent } = setup();
    observer.postToolUse(bashEvent(repo, "cat README.md", `note ${SECRET}\n${pad("# readme")}`));
    await observer.idle();
    expect(jev.transport.calls).toHaveLength(1);
    expect(sent()).not.toContain(SECRET);
    expect(sent()).toContain("# readme");
  });
});

describe("B2: the secret-name rule covers every name a path goes by", () => {
  test("a secret-shaped symlink onto an innocent file", async () => {
    const real = write(repo, "config/app-settings", pad(`note ${SECRET}`));
    symlinkSync(real, path.join(repo, ".env"));
    const { jev, notAsked } = await readCase(path.join(repo, ".env"), pad(`note ${SECRET}`));
    expect(jev.transport.calls).toEqual([]);
    expect(notAsked).toEqual(["secret-path"]);
  });

  test("an innocent name whose middle hop is secret-shaped", async () => {
    const real = write(repo, "config/app-settings", pad(`note ${SECRET}`));
    symlinkSync(real, path.join(repo, ".env.prod"));
    symlinkSync(path.join(repo, ".env.prod"), path.join(repo, "notes.txt"));
    const { jev, notAsked } = await readCase(path.join(repo, "notes.txt"), pad(`note ${SECRET}`));
    expect(jev.transport.calls).toEqual([]);
    expect(notAsked).toEqual(["secret-path"]);
  });

  test("an innocent symlink onto a secret-shaped file", async () => {
    const real = write(repo, ".env.local", pad(`note ${SECRET}`));
    symlinkSync(real, path.join(repo, "settings.txt"));
    const { jev, notAsked } = await readCase(
      path.join(repo, "settings.txt"),
      pad(`note ${SECRET}`),
    );
    expect(jev.transport.calls).toEqual([]);
    expect(notAsked).toEqual(["secret-path"]);
  });

  test("a symlink into ~/.ssh is refused", async () => {
    const real = write(home, ".ssh/notes", pad(`x ${SECRET}`));
    symlinkSync(real, path.join(repo, "notes.txt"));
    const { jev } = await readCase(path.join(repo, "notes.txt"), pad(`x ${SECRET}`));
    expect(jev.transport.calls).toEqual([]);
  });
});

test("B3: a hard link is never sent, whatever its name", async () => {
  const real = write(repo, ".env.prod", pad(`SECRET ${SECRET}`));
  linkSync(real, path.join(repo, "envcopy.txt"));
  const { jev, notAsked } = await readCase(path.join(repo, "envcopy.txt"), pad(`SECRET ${SECRET}`));
  expect(jev.transport.calls).toEqual([]);
  expect(notAsked).toEqual(["secret-path"]);
});

describe("B4: one secret list, the tools track's and the review's additions", () => {
  test.each([
    ".ENV",
    ".env.local",
    ".envrc",
    "id_ed25519",
    "id_ecdsa",
    "id_dsa",
    "x.pem",
    "prod.tfstate",
    "prod.tfstate.backup",
    ".pypirc",
    "secrets.yml",
    "secrets.yaml",
    "service-account.json",
    "service-account-prod.json",
    ".zsh_history",
    ".psql_history",
    ".vault-token",
    "putty.ppk",
    "vault.kdbx",
    ".git-credentials",
    "Credentials.json",
    ".docker/config.json",
  ])("%s is secret-shaped", (name) => {
    expect(isSecretShapedPath(path.join(repo, name))).toBe(true);
  });

  test.each(["README.md", "src/env.ts", "docs/history.md", "keys.ts", "config.json"])(
    "%s is not",
    (name) => {
      expect(isSecretShapedPath(path.join(repo, name))).toBe(false);
    },
  );

  test("every glob matches its own sample, in either case", () => {
    for (const glob of SECRET_PATHSPEC_GLOBS) {
      const sample = glob.replaceAll("*", "x");
      expect(isSecretShapedPath(`/r/${sample}`), glob).toBe(true);
      expect(isSecretShapedPath(`/r/${sample.toUpperCase()}`), glob).toBe(true);
    }
  });

  test.each(["infra/prod.tfstate", "keys/id_ecdsa"])("%s is never sent", async (relative) => {
    const file = write(repo, relative, pad(SECRET));
    const { jev, notAsked } = await readCase(file, pad(SECRET));
    expect(jev.transport.calls).toEqual([]);
    expect(notAsked).toEqual(["secret-path"]);
  });
});

describe("B5: personal locations are never sent, whatever the agent's cwd", () => {
  test.each([
    ".zsh_history",
    "Documents/taxes-2026.txt",
    "Desktop/notes.md",
    "Downloads/statement.csv",
    ".claude/projects/x/session.jsonl",
    ".claude-leader/projects/x/session.jsonl",
    ".claude.json",
    ".config/gh/hosts.yml",
    "Library/Mail/V10/msg.emlx",
    "Library/Messages/chat.db.txt",
    ".mozilla/firefox/profile/prefs.js",
    ".paseo/agents/x.json",
  ])("cwd is HOME: ~/%s", async (relative) => {
    const file = write(home, relative, pad(`note ${SECRET}`));
    const { jev, sent } = await readCase(file, pad(`note ${SECRET}`), home);
    expect(jev.transport.calls).toEqual([]);
    expect(sent()).not.toContain(SECRET);
  });

  test("a dotfiles repo at HOME does not make ~/.zsh_history or ~/notes.txt a project file", async () => {
    mkdirSync(path.join(home, ".git"), { recursive: true });
    for (const relative of [".zsh_history", "notes.txt"]) {
      const file = write(home, relative, pad(`note ${SECRET}`));
      const { jev, notAsked } = await readCase(file, pad(`note ${SECRET}`), home);
      expect(jev.transport.calls).toEqual([]);
      expect(notAsked).toHaveLength(1);
    }
  });

  test("a file in no git work tree is refused as outside-repo", async () => {
    const plain = path.join(home, "scratch");
    const file = write(plain, "notes.md", pad(`note ${SECRET}`));
    const { jev, notAsked } = await readCase(file, pad(`note ${SECRET}`), plain);
    expect(jev.transport.calls).toEqual([]);
    expect(notAsked).toEqual(["outside-repo"]);
  });

  test("with cwd HOME, a file in a project repo below it is still judged", async () => {
    const file = write(repo, "src/app.ts", pad("export const app = 1;"));
    const { jev } = await readCase(file, pad("export const app = 1;"), home);
    expect(jev.transport.calls).toHaveLength(1);
  });
});

describe("M1: live mode decides from metadata before the scope check", () => {
  test("a one-line file is never held waiting on git", async () => {
    const { observer, jev } = setup({ config: { readCheck: { shadow: false, liveShare: 1 } } });
    const small = write(repo, "src/small.ts", "export const x = 1;\n");
    let scopeChecks = 0;
    const checkScope = jev.checkScope.bind(jev);
    jev.checkScope = async (scope) => {
      scopeChecks += 1;
      await new Promise((resolve) => setTimeout(resolve, 800));
      return checkScope(scope);
    };
    const startedAt = Date.now();
    const hold = observer.preToolUse({
      agentId: "a1",
      agentCwd: repo,
      input: {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: small },
        tool_use_id: "p1",
        cwd: repo,
      },
    });
    expect(await hold?.verdict).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(scopeChecks).toBe(0);
  });
});

describe("M2: a use while JEV is answering is recorded", () => {
  test("an Edit landing before the verdict closes the window as a false skip", async () => {
    const content = pad("export function f() {}");
    const file = write(repo, "src/big.ts", content);
    const { observer, jev, validations } = setup();
    let release: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const decide = jev.decide.bind(jev);
    let asked: () => void = () => undefined;
    const askedPromise = new Promise<void>((resolve) => {
      asked = resolve;
    });
    jev.decide = async (input) => {
      asked();
      await answered;
      return decide(input);
    };
    observer.postToolUse(readEvent(repo, file, content));
    await askedPromise;
    observer.preToolUse({
      agentId: "a1",
      agentCwd: repo,
      input: {
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: file, old_string: "a", new_string: "b" },
        tool_use_id: "e1",
        cwd: repo,
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await observer.idle();
    expect(validations).toEqual([
      expect.objectContaining({ outcome: "false-skip", signal: "edited" }),
    ]);
  });
});

describe("M3: work before the lane is bounded", () => {
  test("a burst of large reads judges three at once and drops the rest as saturated", async () => {
    const { observer, jev, notAsked } = setup();
    let decides = 0;
    let release: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const decide = jev.decide.bind(jev);
    jev.decide = async (input) => {
      decides += 1;
      await answered;
      return decide(input);
    };
    for (let index = 0; index < 10; index += 1) {
      const content = pad(`export const file${index} = ${index};`);
      observer.postToolUse(readEvent(repo, write(repo, `src/f${index}.ts`, content), content));
    }
    for (let turn = 0; turn < 20; turn += 1) await new Promise((r) => setImmediate(r));
    release();
    await observer.idle();
    expect(decides).toBe(3);
    expect(notAsked.filter((reason) => reason === "saturated")).toHaveLength(7);
  });

  test("an unavailable answer releases the read's claim, so the next read is judged", async () => {
    const content = pad("export const x = 1;");
    const file = write(repo, "src/x.ts", content);
    const { observer, jev, notAsked } = setup();
    const decide = jev.decide.bind(jev);
    let first = true;
    jev.decide = async (input): Promise<JevOutcome> => {
      if (first) {
        first = false;
        return { kind: "unavailable", callId: "c0", reason: "saturated" };
      }
      return decide(input);
    };
    observer.postToolUse(readEvent(repo, file, content));
    await observer.idle();
    observer.postToolUse(readEvent(repo, file, content));
    await observer.idle();
    expect(notAsked).toEqual(["saturated"]);
    expect(jev.transport.calls).toHaveLength(1);
  });
});
