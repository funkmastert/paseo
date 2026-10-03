import { describe, expect, test } from "vitest";

import { isHomeOrAbove, isInside, isPersonalPath, type PersonalPathRules } from "./paths.js";

const HOME = "/Users/tyler";
const PASEO_HOME = `${HOME}/.paseo`;
const CHECKOUT = `${PASEO_HOME}/worktrees/3jvw4yw6/pinned-grid`;

function rules(overrides: Partial<PersonalPathRules> = {}): PersonalPathRules {
  return { homeDirs: [HOME], paseoHomes: [PASEO_HOME], platform: "darwin", ...overrides };
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
