import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { AgentTimelineItem } from "../../agent/agent-sdk-types.js";
import { resolveJevConfig } from "../config.js";
import type { JevNotAskedReason, JevSavingsSink } from "../contract.js";
import type { JevGitOptions, JevGitResult } from "../egress-scope.js";
import { createTestJevService } from "../fake.js";
import { initGitRepo } from "../test-utils/git-repo.js";
import { ReadCheckObserver } from "./observer.js";

/**
 * The second egress review's probes (feature 16, E1–E6), as tests. Each case puts a marker in a
 * file or a timeline row that must never be sent and checks the bytes the fake transport
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

interface SetupOptions {
  cwd?: string;
  homeDir?: string;
  tail?: AgentTimelineItem[];
  /** Runs once, inside the first scope check, after the path checks and before the file is read. */
  duringScope?: () => void;
  now?: () => number;
  platform?: NodeJS.Platform;
  runGit?: (args: string[], options: JevGitOptions) => Promise<JevGitResult>;
}

interface Harness {
  observer: ReadCheckObserver;
  calls: () => number;
  notAsked: JevNotAskedReason[];
  sent: () => string;
  sentState: () => Record<string, unknown>;
}

function setup(options: SetupOptions = {}): Harness {
  const cwd = options.cwd ?? repo;
  const homeDir = options.homeDir ?? home;
  const jev = createTestJevService({
    paseoHome,
    homeDir,
    config: {},
    answers: { need: { type: "choice", choice: "not_needed", confidence: 0.91 } },
    service: { resolveAgentCwds: async () => [cwd] },
  });
  if (options.duringScope) {
    const duringScope = options.duringScope;
    const checkScope = jev.checkScope.bind(jev);
    let ran = false;
    jev.checkScope = async (scope) => {
      const result = await checkScope(scope);
      if (!ran) duringScope();
      ran = true;
      return result;
    };
  }
  const notAsked: JevNotAskedReason[] = [];
  const savings: JevSavingsSink = {
    record: () => "sv",
    settle: () => undefined,
    validate: () => undefined,
    countNotAsked: (_feature, reason) => notAsked.push(reason),
    noteRead: () => undefined,
  };
  const resolved = resolveJevConfig({}, { homeDir });
  const rows = (options.tail ?? []).map((item, index) => ({
    seq: index + 1,
    timestamp: "2026-09-30T00:00:00Z",
    item,
  }));
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
      tail: () => ({ epoch: "e", rows }),
      after: () => ({ epoch: "e", rows: [] }),
    },
    homeDir,
    paseoHome,
    logger: pino({ level: "silent" }),
    sweepIntervalMs: 0,
    ...(options.now ? { now: options.now } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.runGit ? { runGit: options.runGit } : {}),
  });
  return {
    observer,
    calls: () => jev.transport.calls.length,
    notAsked,
    sent: () => JSON.stringify(jev.transport.calls),
    sentState: () => jev.transport.calls[0]!.state as Record<string, unknown>,
  };
}

function readEvent(
  cwd: string,
  filePath: string,
  content: string,
  toolInput: Record<string, unknown> = { file_path: filePath },
) {
  const lines = content.split("\n").length - 1;
  return {
    agentId: "a1",
    agentCwd: cwd,
    input: {
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: toolInput,
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

async function readCase(
  filePath: string,
  content: string,
  options: SetupOptions & { toolInput?: Record<string, unknown> } = {},
): Promise<Harness> {
  const harness = setup(options);
  const cwd = options.cwd ?? repo;
  harness.observer.postToolUse(readEvent(cwd, filePath, content, options.toolInput));
  await harness.observer.idle();
  return harness;
}

async function bashCase(command: string, options: SetupOptions = {}): Promise<Harness> {
  const harness = setup(options);
  const cwd = options.cwd ?? repo;
  harness.observer.postToolUse(bashEvent(cwd, command, pad(`note ${SECRET}`)));
  await harness.observer.idle();
  return harness;
}

function git(...args: string[]): void {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("GIT_")) delete env[name];
  }
  execFileSync("git", ["-C", repo, ...args], { env, stdio: "ignore" });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "read-check-egress2-")));
  home = path.join(root, "home");
  repo = path.join(home, "projects", "app");
  paseoHome = path.join(home, ".paseo");
  initGitRepo(repo);
  mkdirSync(paseoHome, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("held in review 2: Bash expansion, other readers, wrappers and cd send nothing", () => {
  beforeEach(() => {
    write(repo, ".env", pad(`note ${SECRET}`));
    write(repo, "README.md", pad("# readme ok"));
    write(repo, "list.txt", ".env\n");
    write(home, "Documents/taxes.txt", pad(`ssn ${SECRET}`));
    write(home, "notes.txt", pad(`home ${SECRET}`));
  });

  test.each([
    "cat $F",
    "cat ${HOME}/.env",
    "cat $HOME/Documents/taxes.txt",
    "cat ~/Documents/taxes.txt",
    "cat ~/notes.txt",
    "cat .e*",
    "cat ./.env",
    "cat .ENV",
    'cat "$(echo .env)"',
    "cat `echo .env`",
    "cat $'.env'",
    "cat '.e''nv'",
    "cat \\.env",
    "cat -- .env",
    "cat ./sub/../.env",
    "head -c 99999 .env",
    "tail -n +1 .env",
    "sed -n p .env",
    "sed -n '1,$p' .env",
    "awk '{print}' .env",
    "cut -c1- .env",
    "xxd .env",
    "od -c .env",
    "strings .env",
    "less -N .env",
    "more .env",
    "bat -p --style=plain .env",
    "nl -ba .env",
    "xargs cat < list.txt",
    "echo .env | xargs cat",
    "find . -name .env -exec cat {} \\;",
    "git show HEAD:.env",
    "git cat-file -p HEAD:.env",
    "env cat .env",
    "command cat .env",
    "timeout 5 cat .env",
    "nice cat .env",
    "sudo cat .env",
    "cd ~ && cat notes.txt",
    "cd ~/Documents && cat taxes.txt",
    "cd .. && cd .. && cat notes.txt",
    "cd $D && cat README.md",
    "cat README.md > /dev/null; cat .env",
  ])("%s", async (command) => {
    const { calls, sent } = await bashCase(command);
    expect(calls()).toBe(0);
    expect(sent()).not.toContain(SECRET);
  });

  test.each([
    "cat README.md | xargs cat",
    "cat README.md | sh",
    "bat --pager 'cat .env' README.md",
    "less +'!cat .env' README.md",
  ])("%s sends README from disk, never the output", async (command) => {
    const { calls, sent } = await bashCase(command);
    expect(calls()).toBe(1);
    expect(sent()).toContain("# readme ok");
    expect(sent()).not.toContain(SECRET);
  });

  test("cwd HOME: ~/notes.txt and ~/Documents are refused, a project file below is judged", async () => {
    write(repo, "README.md", pad("# readme ok"));
    for (const command of ["cat notes.txt", "cat Documents/taxes.txt"]) {
      const { calls } = await bashCase(command, { cwd: home });
      expect(calls()).toBe(0);
    }
    const { calls } = await bashCase("cat projects/app/README.md", { cwd: home });
    expect(calls()).toBe(1);
  });
});

describe("E2: what is sent is the file the checks saw", () => {
  test("Bash: notes.txt swapped to a symlink onto .env.prod during the scope check", async () => {
    const secret = write(repo, ".env.prod", pad(`note ${SECRET}`));
    const notes = write(repo, "notes.txt", pad("innocent notes"));
    const { calls, sent, notAsked } = await bashCase("cat notes.txt", {
      duringScope: () => {
        unlinkSync(notes);
        symlinkSync(secret, notes);
      },
    });
    expect(calls()).toBe(0);
    expect(sent()).not.toContain(SECRET);
    expect(notAsked).toEqual(["changed"]);
  });

  test("Bash: a copy of .env.prod renamed over notes.txt during the scope check", async () => {
    const secret = write(repo, ".env.prod", pad(`note ${SECRET}`));
    const notes = write(repo, "notes.txt", pad("innocent notes"));
    const { calls, notAsked } = await bashCase("cat notes.txt", {
      duringScope: () => {
        copyFileSync(secret, `${notes}.tmp`);
        renameSync(`${notes}.tmp`, notes);
      },
    });
    expect(calls()).toBe(0);
    expect(notAsked).toEqual(["changed"]);
  });

  test("Bash: notes.txt rewritten in place during the scope check", async () => {
    const notes = write(repo, "notes.txt", pad("innocent notes"));
    const { calls, notAsked } = await bashCase("cat notes.txt", {
      duringScope: () => writeFileSync(notes, pad(`note ${SECRET} and more`)),
    });
    expect(calls()).toBe(0);
    expect(notAsked).toEqual(["changed"]);
  });

  test("Read: a symlink onto .env.prod when read, a regular file when the observer looks", async () => {
    const secret = write(repo, ".env.prod", pad(`note ${SECRET}`));
    const notes = path.join(repo, "notes.txt");
    symlinkSync(secret, notes);
    const harness = setup();
    harness.observer.postToolUse(readEvent(repo, notes, pad(`note ${SECRET}`)));
    unlinkSync(notes);
    writeFileSync(notes, pad(`note ${SECRET}`.replace(SECRET, "innocent")));
    await harness.observer.idle();
    expect(harness.calls()).toBe(0);
    expect(harness.sent()).not.toContain(SECRET);
    expect(harness.notAsked).toEqual(["changed"]);
  });

  test("Read: text that is not what is on disk is never sent", async () => {
    const file = write(repo, "src/app.ts", pad("export const app = 1;"));
    const { calls, notAsked } = await readCase(file, pad(`export const app = 1; ${SECRET}`));
    expect(calls()).toBe(0);
    expect(notAsked).toEqual(["changed"]);
  });

  test("Read: an offset and limit read is compared on its own lines, and sent", async () => {
    const file = write(repo, "src/app.ts", pad("export const app = 1;"));
    const lines = pad("export const app = 1;").split("\n");
    const content = `${lines.slice(9, 309).join("\n")}\n`;
    const harness = setup();
    const event = readEvent(repo, file, content, { file_path: file, offset: 10, limit: 300 });
    event.input.tool_response.file = {
      filePath: file,
      content,
      numLines: 300,
      startLine: 10,
      totalLines: lines.length - 1,
    };
    harness.observer.postToolUse(event);
    await harness.observer.idle();
    expect(harness.calls()).toBe(1);
  });
});

describe("E3: `~` in Read's file_path is the home directory, as the CLI expands it", () => {
  test("a literal ~ directory in the repo is not judged in place of the real home file", async () => {
    const real = write(home, "Documents/taxes.txt", pad(`ssn ${SECRET}`));
    write(repo, "~/Documents/taxes.txt", pad("decoy innocent"));
    const { calls, sent, notAsked } = await readCase(real, pad(`ssn ${SECRET}`), {
      toolInput: { file_path: "~/Documents/taxes.txt" },
    });
    expect(calls()).toBe(0);
    expect(sent()).not.toContain(SECRET);
    expect(notAsked).toEqual(["outside-cwd"]);
  });

  test("with no decoy, the same read is refused too", async () => {
    const real = write(home, "Documents/taxes.txt", pad(`ssn ${SECRET}`));
    const { calls } = await readCase(real, pad(`ssn ${SECRET}`), {
      toolInput: { file_path: "~/Documents/taxes.txt" },
    });
    expect(calls()).toBe(0);
  });

  test("the decoy's own text under a ~ path is refused by the disk comparison", async () => {
    write(home, "Documents/taxes.txt", pad(`ssn ${SECRET}`));
    const decoy = write(repo, "~/Documents/taxes.txt", pad("decoy innocent"));
    const { calls } = await readCase(decoy, pad(`ssn ${SECRET}`));
    expect(calls()).toBe(0);
  });
});

describe("E4: an ignored file outside dependency and build output is never sent", () => {
  const files: Record<string, string> = {
    "appsettings.Development.json": `{"Jwt":{"Signing":"${SECRET}"}}`,
    "config/database.yml": `production:\n  password: ${SECRET}\n`,
    ".dev.vars": `CF_SIGNING=${SECRET}\n`,
    "config/secrets.json": `{"stripe":"${SECRET}"}`,
    ".yarnrc.yml": `npmAuthToken: ${SECRET}\n`,
    "wrangler.toml": `[vars]\nSIGNING = "${SECRET}"\n`,
    ".terraformrc": `credentials "app.terraform.io" { token = "${SECRET}" }\n`,
    ".s3cfg": `[default]\nsecret_key = ${SECRET}\n`,
    ".htpasswd": `admin:$apr1$${SECRET}\n`,
    "auth.json": `{"http-basic":{"repo.example":{"password":"${SECRET}"}}}`,
    "firebase-adminsdk-abc12.json": `{"type":"service_account","private_key_id":"${SECRET}"}`,
    "gcp-prod-4f2a.json": `{"type":"service_account","private_key_id":"${SECRET}"}`,
    ".my.cnf": `[client]\npassword=${SECRET}\n`,
    "docker-compose.override.yml": `services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: ${SECRET}\n`,
    "gradle.properties": `RELEASE_STORE_PASSWORD=${SECRET}\n`,
    "settings.local.py": `SECRET_KEY = '${SECRET}'\n`,
    "config/master.key": `${SECRET}\n`,
    ".npmrc.bak": `//registry.npmjs.org/:_authToken=${SECRET}\n`,
    ".env.bak": `X=${SECRET}\n`,
    "env.local": `X=${SECRET}\n`,
    dotenv: `X=${SECRET}\n`,
    "secret.txt": `${SECRET}\n`,
    token: `${SECRET}\n`,
    "private.asc": `-----BEGIN PGP PRIVATE KEY BLOCK-----\n${SECRET}\n`,
    "client.ovpn": `<key>\n${SECRET}\n</key>\n`,
    "wp-config.php": `define('DB_PASSWORD', '${SECRET}');\n`,
    "credentials.yml.enc": `${SECRET}\n`,
  };

  test.each(Object.keys(files))("gitignored %s", async (relative) => {
    writeFileSync(path.join(repo, ".gitignore"), `${Object.keys(files).join("\n")}\n`);
    const content = files[relative]! + pad("").slice(1);
    const file = write(repo, relative, content);
    const { calls, sent, notAsked } = await readCase(file, content);
    expect(calls()).toBe(0);
    expect(sent()).not.toContain(SECRET);
    expect(notAsked).toEqual(["secret-path"]);
  });

  test.each([
    ".dev.vars",
    "env.local",
    "config/secrets.json",
    "wp-config.php",
    ".htpasswd",
    "client.ovpn",
    "firebase-adminsdk-abc12.json",
    "gcp-prod-4f2a.json",
  ])("%s is refused by name even when git does not ignore it", async (relative) => {
    const content = files[relative]! + pad("").slice(1);
    const file = write(repo, relative, content);
    const { calls, notAsked } = await readCase(file, content);
    expect(calls()).toBe(0);
    expect(notAsked).toEqual(["secret-path"]);
  });

  test.each(["node_modules/pkg/index.js", "dist/bundle.js", "build/out.js", "vendor/lib/a.rb"])(
    "ignored dependency or build output %s is judged",
    async (relative) => {
      writeFileSync(path.join(repo, ".gitignore"), "node_modules/\ndist/\nbuild/\nvendor/\n");
      const file = write(repo, relative, pad("module.exports = 1;"));
      const { calls } = await readCase(file, pad("module.exports = 1;"));
      expect(calls()).toBe(1);
    },
  );

  test("a tracked file that an ignore pattern also matches is a project file, and judged", async () => {
    writeFileSync(path.join(repo, ".gitignore"), "*.json\n");
    const file = write(repo, "tsconfig.json", pad('{"compilerOptions": {}}'));
    git("add", "-f", "tsconfig.json");
    const { calls } = await readCase(file, pad('{"compilerOptions": {}}'));
    expect(calls()).toBe(1);
  });

  test("git failing to answer refuses the file", async () => {
    const file = write(repo, "src/app.ts", pad("export const app = 1;"));
    for (const runGit of [
      async () => ({ exitCode: 128, stdout: "", stderr: "fatal: not a git repository" }),
      async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true }),
      async (): Promise<JevGitResult> => {
        throw new Error("spawn git ENOENT");
      },
    ]) {
      const { calls, notAsked } = await readCase(file, pad("export const app = 1;"), { runGit });
      expect(calls()).toBe(0);
      expect(notAsked).toEqual(["secret-path"]);
    }
  });
});

describe("E5: a copy of a secret file the agent made is refused for 24 hours", () => {
  const ENV = [
    "DATABASE_URL=postgres://app:Pg_s3cret_pw@db.internal:5432/app",
    "ADMIN_PASSWORD=correct horse battery",
    "ENCRYPTION_SALT=Qx7pL2vN9mK4",
    `PRIVATE=${SECRET}`,
  ].join("\n");
  const NEEDLES = ["Pg_s3cret_pw", "horse battery", "Qx7pL2vN9mK4", SECRET];

  async function copyThenRead(
    command: string,
    copied: string,
    options: SetupOptions = {},
  ): Promise<Harness> {
    const content = `${ENV}\n${pad("").slice(1)}`;
    write(repo, ".env.production", content);
    write(repo, "backup/.keep", "");
    const harness = setup(options);
    harness.observer.postToolUse(bashEvent(repo, command, ""));
    // The command ran: make what it wrote.
    write(repo, copied, content);
    harness.observer.postToolUse(readEvent(repo, path.join(repo, copied), content));
    await harness.observer.idle();
    return harness;
  }

  test.each([
    ["cp .env.production notes.txt", "notes.txt"],
    ["mv .env.production moved.txt", "moved.txt"],
    ["cp -p ./.env.production backup/", "backup/.env.production"],
    ["cp -t backup .env.production", "backup/.env.production"],
    ["rsync -a .env.production synced.txt", "synced.txt"],
    ["ditto .env.production dittoed.txt", "dittoed.txt"],
    ["install -m 600 .env.production installed.txt", "installed.txt"],
    ["cat .env.production > dump.txt", "dump.txt"],
    ["cat .env.production | tee teed.txt", "teed.txt"],
    ["cd backup && cp ../.env.production ../nested.txt", "nested.txt"],
  ])("%s", async (command, copied) => {
    const { calls, sent, notAsked } = await copyThenRead(command, copied);
    expect(calls()).toBe(0);
    for (const needle of NEEDLES) expect(sent()).not.toContain(needle);
    expect(notAsked).toEqual(["secret-path"]);
  });

  test("a copy of a copy is refused too", async () => {
    const content = `${ENV}\n${pad("").slice(1)}`;
    write(repo, ".env.production", content);
    const harness = setup();
    harness.observer.postToolUse(bashEvent(repo, "cp .env.production a.txt", ""));
    harness.observer.postToolUse(bashEvent(repo, "cp a.txt b.txt", ""));
    write(repo, "b.txt", content);
    harness.observer.postToolUse(readEvent(repo, path.join(repo, "b.txt"), content));
    await harness.observer.idle();
    expect(harness.calls()).toBe(0);
  });

  test("a copy of an ordinary file is judged", async () => {
    write(repo, "README.md", pad("# readme"));
    const harness = setup();
    harness.observer.postToolUse(bashEvent(repo, "cp README.md copy.md", ""));
    write(repo, "copy.md", pad("# readme"));
    harness.observer.postToolUse(readEvent(repo, path.join(repo, "copy.md"), pad("# readme")));
    await harness.observer.idle();
    expect(harness.calls()).toBe(1);
  });

  test("after 24 hours the copy is judged, and redaction still holds its values back", async () => {
    let now = Date.parse("2026-09-30T00:00:00Z");
    const content = `${ENV}\n${pad("").slice(1)}`;
    write(repo, ".env.production", content);
    const harness = setup({ now: () => now });
    harness.observer.postToolUse(bashEvent(repo, "cp .env.production notes.txt", ""));
    await harness.observer.idle();
    write(repo, "notes.txt", content);
    now += 24 * 60 * 60_000 + 1;
    harness.observer.postToolUse(readEvent(repo, path.join(repo, "notes.txt"), content));
    await harness.observer.idle();
    expect(harness.calls()).toBe(1);
    for (const needle of NEEDLES) expect(harness.sent()).not.toContain(needle);
  });

  test("a copy made outside the session is judged, and redaction holds its values back", async () => {
    const content = `${ENV}\n${pad("").slice(1)}`;
    const file = write(repo, "notes.txt", content);
    const { calls, sent } = await readCase(file, content);
    expect(calls()).toBe(1);
    for (const needle of NEEDLES) expect(sent()).not.toContain(needle);
  });
});

describe("E5: names built to look like secret ones", () => {
  test.each([".еnv", "．env", ".env ", ".env.", ".env.."])("%j is refused", async (name) => {
    const file = write(repo, name, pad(`note ${SECRET}`));
    const { calls, notAsked } = await readCase(file, pad(`note ${SECRET}`));
    expect(calls()).toBe(0);
    expect(notAsked).toEqual(["secret-path"]);
  });

  test.each([".env ", ".еnv"])("%j is refused on win32", async (name) => {
    const file = write(repo, name, pad(`note ${SECRET}`));
    const { calls, notAsked } = await readCase(file, pad(`note ${SECRET}`), {
      platform: "win32",
    });
    expect(calls()).toBe(0);
    expect(notAsked).toEqual(["secret-path"]);
  });
});

describe("E1 and E6: what `recent` sends", () => {
  test("credentials in shell commands are redacted and error rows are dropped", async () => {
    const file = write(repo, "src/app.ts", pad("export const app = 1;"));
    const tail: AgentTimelineItem[] = [
      { type: "user_message", text: `here is the prod db password: ${SECRET}` },
      {
        type: "tool_call",
        callId: "c1",
        name: "Bash",
        status: "completed",
        error: null,
        detail: { type: "shell", command: `PGPASSWORD=${SECRET}y psql -h db -U app -c 'select 1'` },
      },
      {
        type: "tool_call",
        callId: "c2",
        name: "Bash",
        status: "completed",
        error: null,
        detail: { type: "shell", command: `curl -u admin:${SECRET}z https://api.example.com` },
      },
      {
        type: "tool_call",
        callId: "c3",
        name: "Bash",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "redis-cli -a pw12 ping && http -a admin:pw34 x.io" },
      },
      { type: "error", message: `auth failed for token ${SECRET}v` },
    ];
    const { calls, sent, sentState } = await readCase(file, pad("export const app = 1;"), {
      tail,
    });
    expect(calls()).toBe(1);
    for (const needle of [SECRET, `${SECRET}y`, `${SECRET}z`, `${SECRET}v`, "pw12", "pw34"]) {
      expect(sent()).not.toContain(needle);
    }
    const recent = sentState()["recent"] as string[];
    expect(recent.some((line) => line.startsWith("error:"))).toBe(false);
    expect(recent).toContain(
      "tool Bash `curl -u admin:[redacted:argument] https://api.example.com`",
    );
  });
});
