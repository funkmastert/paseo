import { describe, expect, test } from "vitest";

import { isNamedRead } from "./named.js";

describe("isNamedRead", () => {
  test("the brief naming the exact path matches", () => {
    expect(
      isNamedRead(
        {
          namedPath: "docs/plans/x-plan.md",
          displayPath: "docs/plans/x-plan.md",
          realPath: "/repo/docs/plans/x-plan.md",
        },
        { texts: ["Read docs/plans/x-plan.md, then summarize it"] },
      ),
    ).toBe(true);
  });

  test("a base name mentioned in recent assistant text matches", () => {
    expect(
      isNamedRead(
        {
          namedPath: "ios/Deal/DealProfileScreen.swift",
          displayPath: "ios/Deal/DealProfileScreen.swift",
          realPath: "/repo/ios/Deal/DealProfileScreen.swift",
        },
        { texts: ["assistant: Let's open DealProfileScreen.swift next"] },
      ),
    ).toBe(true);
  });

  test("the base name alone does not match when it is generic, even past the length floor", () => {
    expect(
      isNamedRead(
        {
          namedPath: "src/components/index.ts",
          displayPath: "src/components/index.ts",
          realPath: "/repo/src/components/index.ts",
        },
        { texts: ["assistant: check index.ts for the export"] },
      ),
    ).toBe(false);
  });

  test("a full relative path containing a generic base name does match", () => {
    expect(
      isNamedRead(
        {
          namedPath: "src/components/index.ts",
          displayPath: "src/components/index.ts",
          realPath: "/repo/src/components/index.ts",
        },
        { texts: ["assistant: check src/components/index.ts for the export"] },
      ),
    ).toBe(true);
  });

  test("a short base name under the floor does not match on its own", () => {
    expect(
      isNamedRead(
        { namedPath: "a/x.ts", displayPath: "a/x.ts", realPath: "/repo/a/x.ts" },
        { texts: ["assistant: check x.ts"] },
      ),
    ).toBe(false);
  });

  test("a path mentioned only inside the file's own excerpt does not count", () => {
    // The caller never includes the excerpt or outline in `texts` (R2); a path that appears only
    // there is invisible to this check.
    expect(
      isNamedRead(
        {
          namedPath: "src/templates/base.hbs",
          displayPath: "src/templates/base.hbs",
          realPath: "/repo/src/templates/base.hbs",
        },
        { texts: ["assistant: Looking at the login flow"] },
      ),
    ).toBe(false);
  });

  test("a root-level file's path is its own base name: the denylist still applies to it", () => {
    // `displayPath`/`namedPath` equal the bare base name for any file at the agent's cwd root —
    // the direct-path shortcut must not let a generic name skip the denylist just because of that.
    expect(
      isNamedRead(
        { namedPath: "package.json", displayPath: "package.json", realPath: "/repo/package.json" },
        { texts: ["assistant: check package.json for the dependency"] },
      ),
    ).toBe(false);
  });

  test("a root-level file's path still matches when its base name is not generic", () => {
    expect(
      isNamedRead(
        {
          namedPath: "webpack.config.js",
          displayPath: "webpack.config.js",
          realPath: "/repo/webpack.config.js",
        },
        { texts: ["assistant: check webpack.config.js for the alias"] },
      ),
    ).toBe(true);
  });

  test("nothing in context is a non-match, not a throw", () => {
    expect(
      isNamedRead(
        { namedPath: "a.ts", displayPath: "a.ts", realPath: "/repo/a.ts" },
        { texts: [null, undefined, ""] },
      ),
    ).toBe(false);
  });
});
