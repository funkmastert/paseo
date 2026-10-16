import { describe, expect, test } from "vitest";

import {
  isHomeOrAbove,
  isInside,
  isPersonalPath,
  shadowOnlyKind,
  type PersonalPathRules,
} from "./paths.js";

const HOME = "/Users/tyler";
const PASEO_HOME = `${HOME}/.paseo`;
const CHECKOUT = `${PASEO_HOME}/worktrees/3jvw4yw6/pinned-grid`;

const TMP = "/private/tmp";

function rules(overrides: Partial<PersonalPathRules> = {}): PersonalPathRules {
  return {
    homeDirs: [HOME],
    paseoHomes: [PASEO_HOME],
    tmpDirs: [TMP, "/tmp"],
    platform: "darwin",
    ...overrides,
  };
}

describe("an agent's checkout under Paseo's home is judgeable", () => {
  test.each([
    `${CHECKOUT}/packages/server/src/server/jev/read-check/paths.ts`,
    `${CHECKOUT}/CLAUDE.md`,
    `${CHECKOUT}/node_modules/react/index.js`,
  ])("not personal: %s", (candidate) => {
    expect(isPersonalPath(candidate, rules())).toBe(false);
  });

  test("the exemption beats the home dot-entry rule, since Paseo's home is ~/.paseo", () => {
    // Without the exemption `.paseo` is just another dot-entry directly under the home directory.
    expect(isPersonalPath(`${HOME}/.paseoish/worktrees/p/a/src/x.ts`, rules())).toBe(true);
    expect(isPersonalPath(`${CHECKOUT}/src/x.ts`, rules())).toBe(false);
  });

  test("a second spelling of Paseo's home exempts its checkouts too", () => {
    const linked = "/Volumes/work/paseo";
    expect(
      isPersonalPath(
        `${linked}/worktrees/p/a/src/x.ts`,
        rules({ paseoHomes: [PASEO_HOME, linked] }),
      ),
    ).toBe(false);
  });
});

describe("the rest of Paseo's home is the daemon's own state", () => {
  test.each([
    `${PASEO_HOME}/config.json`,
    `${PASEO_HOME}/credentials.json`,
    `${PASEO_HOME}/agents/-Users-tyler-app/a1.json`,
    `${PASEO_HOME}/jev/audit.jsonl`,
    `${PASEO_HOME}/daemon.log`,
    // A directory the daemon grows later is private until someone decides otherwise.
    `${PASEO_HOME}/tokens/anthropic.json`,
    // Not inside any checkout: the worktrees root and a project directory are daemon layout.
    `${PASEO_HOME}/worktrees/stray.md`,
    `${PASEO_HOME}/worktrees/3jvw4yw6/notes.md`,
  ])("personal: %s", (candidate) => {
    expect(isPersonalPath(candidate, rules())).toBe(true);
  });

  test("a symlinked Paseo home is refused in both spellings", () => {
    const real = "/Volumes/work/paseo";
    const both = rules({ paseoHomes: [PASEO_HOME, real] });
    expect(isPersonalPath(`${PASEO_HOME}/config.json`, both)).toBe(true);
    expect(isPersonalPath(`${real}/config.json`, both)).toBe(true);
  });
});

describe("personal locations outside Paseo's home are unchanged", () => {
  test.each([
    `${HOME}/.zsh_history`,
    `${HOME}/.ssh/id_ed25519.pub`,
    `${HOME}/.claude/projects/x/session.jsonl`,
    `${HOME}/Documents/taxes-2026.txt`,
    `${HOME}/Library/Mail/V10/msg.emlx`,
  ])("personal: %s", (candidate) => {
    expect(isPersonalPath(candidate, rules())).toBe(true);
  });

  test("a project under the home directory is not personal", () => {
    expect(isPersonalPath(`${HOME}/projects/app/src/app.ts`, rules())).toBe(false);
  });

  test("the home directory and its ancestors are above a project repository", () => {
    expect(isHomeOrAbove(HOME, rules())).toBe(true);
    expect(isHomeOrAbove("/Users", rules())).toBe(true);
    expect(isHomeOrAbove(`${HOME}/projects/app`, rules())).toBe(false);
  });
});

describe("one file spelled two ways compares as one file", () => {
  test("a sibling whose name starts with the cwd's is outside it", () => {
    expect(isInside(`${HOME}/projects/app2/src/x.ts`, `${HOME}/projects/app`, "linux")).toBe(false);
    expect(isInside(`${HOME}/projects/app/src/x.ts`, `${HOME}/projects/app`, "linux")).toBe(true);
  });

  test("case folds where the volume folds", () => {
    expect(isInside(`${HOME}/Projects/App/src/x.ts`, `${HOME}/projects/app`, "darwin")).toBe(true);
    expect(isInside(`${HOME}/Projects/App/src/x.ts`, `${HOME}/projects/app`, "linux")).toBe(false);
  });

  test("a decomposed name matches its composed form", () => {
    const composed = `${HOME}/projets/café`.normalize("NFC");
    const decomposed = `${HOME}/projets/café`.normalize("NFD");
    expect(composed).not.toBe(decomposed);
    expect(isInside(`${decomposed}/src/x.ts`, composed, "linux")).toBe(true);
    expect(isPersonalPath(`${decomposed}/x.ts`, rules({ homeDirs: [composed] }))).toBe(false);
  });

  // On macOS and Linux a backslash is an ordinary filename character, so two directories that
  // differ only by one are different directories.
  test.skipIf(process.platform === "win32")(
    "a backslash in a name is not a separator off Windows",
    () => {
      const sibling = `${HOME}/projects/app\\private/key.ts`;
      expect(isInside(sibling, `${HOME}/projects/app`, "linux")).toBe(false);
      expect(isInside(sibling, `${HOME}/projects/app`, "darwin")).toBe(false);
      // The segments a rule reads must not split on it either: this is `worktrees/p/<one dir>`,
      // which is not inside a checkout.
      expect(isPersonalPath(`${PASEO_HOME}/worktrees/p/a\\b`, rules())).toBe(true);
    },
  );

  test("a directory whose name starts with .. is below its parent, not above it", () => {
    // `path.relative` answers `..secret/x`; a prefix test reads that as having climbed out, and
    // the daemon's state would stop being personal.
    expect(isPersonalPath(`${PASEO_HOME}/..secret/tokens.json`, rules())).toBe(true);
    expect(isInside(`${HOME}/projects/app/..build/out.ts`, `${HOME}/projects/app`, "linux")).toBe(
      true,
    );
    // A real climb is still outside.
    expect(isPersonalPath(`${HOME}/projects/app/x.ts`, rules())).toBe(false);
    expect(isInside(`${HOME}/projects/other/x.ts`, `${HOME}/projects/app`, "linux")).toBe(false);
  });

  test("a decomposed home still catches its own dot-entries", () => {
    const composed = `${HOME}/projets/café`.normalize("NFC");
    const decomposed = `${HOME}/projets/café`.normalize("NFD");
    expect(isPersonalPath(`${decomposed}/.ssh/id_ed25519`, rules({ homeDirs: [composed] }))).toBe(
      true,
    );
  });

  // `fs.realpath` keeps whichever of the two macOS spellings it was handed, so the file and the
  // cwd can arrive on opposite sides of the firmlink.
  test.skipIf(process.platform === "win32")("macOS's data volume is the same path", () => {
    const viaDataVolume = `/System/Volumes/Data${HOME}/projects/app/src/x.ts`;
    expect(isInside(viaDataVolume, `${HOME}/projects/app`, "darwin")).toBe(true);
    expect(
      isInside(
        `${HOME}/projects/app/src/x.ts`,
        `/System/Volumes/Data${HOME}/projects/app`,
        "darwin",
      ),
    ).toBe(true);
    expect(isInside(viaDataVolume, `${HOME}/projects/app`, "linux")).toBe(false);
    // Fail closed: a personal location reached through the firmlink is still personal.
    expect(isPersonalPath(`/System/Volumes/Data${PASEO_HOME}/config.json`, rules())).toBe(true);
    expect(isPersonalPath(`/System/Volumes/Data${HOME}/.ssh/config`, rules())).toBe(true);
  });
});

describe("the shadow-only subtrees (D12)", () => {
  const cache = `${HOME}/.claude/plugins/cache/compound-engineering-plugin/skills/ce-work`;

  test.each([
    [`${cache}/SKILL.md`, "skill-docs"],
    [`${cache}/references/execution-engines.md`, "skill-docs"],
    [`${HOME}/.claude-leader/plugins/cache/p/skills/x/SKILL.md`, "skill-docs"],
    [`${HOME}/.claude-personal/plugins/cache/p/SKILL.md`, "skill-docs"],
    ["/tmp/compound-engineering/ce-compound/20261002-105557/solution.md", "ce-scratch"],
    ["/private/tmp/compound-engineering/ce-compound/20261002-105557/solution.md", "ce-scratch"],
  ])("%s is %s", (candidate, kind) => {
    expect(shadowOnlyKind(candidate, rules())).toBe(kind);
    expect(isPersonalPath(candidate, rules())).toBe(false);
  });

  test("the carve-out is `plugins/cache` and nothing else under the Claude config dirs", () => {
    for (const candidate of [
      `${HOME}/.claude/.credentials.json`,
      `${HOME}/.claude/settings.json`,
      `${HOME}/.claude/history.jsonl`,
      `${HOME}/.claude/projects/x/session.jsonl`,
      `${HOME}/.claude/plugins/config.json`,
      `${HOME}/.claude/plugins/marketplaces/x/token`,
      `${HOME}/.claude-leader/.credentials.json`,
      `${HOME}/.claude.json`,
    ]) {
      expect(shadowOnlyKind(candidate, rules())).toBeNull();
      expect(isPersonalPath(candidate, rules())).toBe(true);
    }
  });

  test("the cache directory itself is not a file in it", () => {
    expect(shadowOnlyKind(`${HOME}/.claude/plugins/cache`, rules())).toBeNull();
    expect(shadowOnlyKind("/tmp/compound-engineering", rules())).toBeNull();
  });

  test("a sibling of the scratch directory is not scratch", () => {
    expect(shadowOnlyKind("/tmp/compound-engineering-other/x.md", rules())).toBeNull();
    expect(shadowOnlyKind("/tmp/other/x.md", rules())).toBeNull();
  });

  test("`..` cannot climb out of either subtree", () => {
    expect(
      shadowOnlyKind(`${HOME}/.claude/plugins/cache/../../.credentials.json`, rules()),
    ).toBeNull();
    expect(isPersonalPath(`${HOME}/.claude/plugins/cache/../../.credentials.json`, rules())).toBe(
      true,
    );
    expect(shadowOnlyKind("/tmp/compound-engineering/../../etc/passwd", rules())).toBeNull();
    // A directory merely named `..secret` is still inside the subtree.
    expect(shadowOnlyKind(`${cache}/..secret/notes.md`, rules())).toBe("skill-docs");
  });

  test("a tmpdir elsewhere is covered, and only its own scratch", () => {
    const windowsish = rules({ tmpDirs: ["/var/folders/ab/T"], platform: "linux" });
    expect(shadowOnlyKind("/var/folders/ab/T/compound-engineering/x.md", windowsish)).toBe(
      "ce-scratch",
    );
    expect(shadowOnlyKind("/tmp/compound-engineering/x.md", windowsish)).toBeNull();
  });

  test.skipIf(process.platform !== "win32")("a Windows-shaped path matches", () => {
    const win = rules({
      homeDirs: ["C:\\Users\\tyler"],
      paseoHomes: ["C:\\Users\\tyler\\.paseo"],
      tmpDirs: ["C:\\Users\\tyler\\AppData\\Local\\Temp"],
      platform: "win32",
    });
    expect(shadowOnlyKind("C:\\Users\\tyler\\.claude\\plugins\\cache\\p\\SKILL.md", win)).toBe(
      "skill-docs",
    );
    expect(
      shadowOnlyKind("C:\\Users\\tyler\\AppData\\Local\\Temp\\compound-engineering\\x.md", win),
    ).toBe("ce-scratch");
    expect(shadowOnlyKind("C:\\Users\\tyler\\.claude\\.credentials.json", win)).toBeNull();
  });
});
