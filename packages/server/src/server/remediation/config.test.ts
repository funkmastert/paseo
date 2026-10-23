import { describe, expect, it } from "vitest";

import { defaultConditionNotify } from "./config.js";
import type { RemediationConditionKind } from "./contract.js";

describe("defaultConditionNotify", () => {
  it.each([
    "orphan-build-daemons",
    "system-memory",
    "cpu-saturation",
    "disk-critical",
    "disk-low",
    "disk-falling",
    "stalled-agent",
    "work-at-risk",
  ] as const satisfies readonly RemediationConditionKind[])(
    "defaults %s to the ledger, not a push",
    (kind) => {
      expect(defaultConditionNotify(kind)).toBe(false);
    },
  );

  it.each([
    "account-pool-exhausted",
    "account-signed-out",
    "token-audit",
    "looping-agent",
  ] as const satisfies readonly RemediationConditionKind[])(
    "keeps %s pushing by default",
    (kind) => {
      expect(defaultConditionNotify(kind)).toBe(true);
    },
  );
});
