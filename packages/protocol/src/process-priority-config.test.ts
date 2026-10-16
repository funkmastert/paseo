import { describe, expect, test } from "vitest";

import { MutableDaemonConfigPatchSchema } from "./messages.js";

describe("processPriority patch", () => {
  test("accepts nice values from 0 to 19", () => {
    const processPriority = { enabled: false, agentNice: 0, backgroundNice: 19 };
    expect(MutableDaemonConfigPatchSchema.parse({ processPriority }).processPriority).toEqual(
      processPriority,
    );
  });

  test.each([-1, 20])("rejects a nice of %s", (nice) => {
    expect(
      MutableDaemonConfigPatchSchema.safeParse({ processPriority: { agentNice: nice } }).success,
    ).toBe(false);
  });
});
