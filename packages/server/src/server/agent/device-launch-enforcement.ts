/**
 * How much of the device cap (docs/device-leases.md) a given provider can actually be held to.
 *
 * The cap's three layers assume a fourth thing that is not true: that every provider can be
 * stopped at the tool call. Only some can. A cap that silently binds Claude and not Codex is
 * worse than no cap — the well-behaved agents queue while the unguarded one takes their slots —
 * so the asymmetry is a value the daemon carries, shows in the UI, and tells agents about,
 * rather than something you learn by reading provider source.
 *
 * Three tiers, in descending strength:
 *
 *   refuses   The daemon stops the command before it runs, in every mode the provider has.
 *   asks      The daemon only gets a say when the agent routes the command through it — an
 *             approval request, or a terminal it asks the daemon to spawn. Refusal is real
 *             when that happens, and there are modes and agents where it does not.
 *   observes  Nothing intercepts. The device is counted after it boots, and never refused.
 *
 * Every tier still counts: occupancy is the union of running devices and leases, so a device
 * booted by an `observes` agent fills a slot for everybody. The tier is about refusal, not
 * about counting.
 */

/** Ordered weakest to strongest so a tier can be compared, not just matched. */
export const DEVICE_LAUNCH_ENFORCEMENT_TIERS = ["observes", "asks", "refuses"] as const;

export type DeviceLaunchEnforcementTier = (typeof DEVICE_LAUNCH_ENFORCEMENT_TIERS)[number];

export interface DeviceLaunchEnforcement {
  tier: DeviceLaunchEnforcementTier;
  /** What the daemon holds, in one line. Shown to agents and written into the docs verbatim. */
  mechanism: string;
  /** The hole, where there is one. Absent only for a tier that has none. */
  gap?: string;
}

/**
 * Keyed by the builtin provider id, and by the derived ACP provider ids the registry creates
 * from `extends: "acp"` (cursor, kimi, kiro, traecli). A provider that is not in here is
 * `observes` — the honest default for an agent nobody has checked, and the only one that
 * cannot overstate what the cap does.
 */
const ENFORCEMENT_BY_PROVIDER: Record<string, DeviceLaunchEnforcement> = {
  claude: {
    tier: "refuses",
    mechanism: "a PreToolUse hook on Bash, which runs in every permission mode",
  },
  opencode: {
    tier: "refuses",
    mechanism: "the Paseo bridge plugin's tool.execute.before hook on the bash tool",
  },
  codex: {
    tier: "asks",
    mechanism: "the command-approval request Codex sends before running a sandboxed command",
    gap: "Full Access sets Codex's approval policy to never, so it asks nothing and boots freely",
  },
  copilot: {
    tier: "asks",
    mechanism:
      "the terminal the daemon spawns on the agent's behalf, and the permission request it sends first",
    gap: "an agent that runs a shell inside its own process, asking the daemon for neither, is not refused",
  },
  cursor: {
    tier: "asks",
    mechanism:
      "the terminal the daemon spawns on the agent's behalf, and the permission request it sends first",
    gap: "an agent that runs a shell inside its own process, asking the daemon for neither, is not refused",
  },
  kimi: {
    tier: "asks",
    mechanism:
      "the terminal the daemon spawns on the agent's behalf, and the permission request it sends first",
    gap: "an agent that runs a shell inside its own process, asking the daemon for neither, is not refused",
  },
  kiro: {
    tier: "asks",
    mechanism:
      "the terminal the daemon spawns on the agent's behalf, and the permission request it sends first",
    gap: "an agent that runs a shell inside its own process, asking the daemon for neither, is not refused",
  },
  traecli: {
    tier: "asks",
    mechanism:
      "the terminal the daemon spawns on the agent's behalf, and the permission request it sends first",
    gap: "an agent that runs a shell inside its own process, asking the daemon for neither, is not refused",
  },
  omp: {
    tier: "asks",
    mechanism: "the bash tool approval OMP raises through its extension UI",
    gap: "an OMP configured not to approve bash is not refused",
  },
  pi: {
    tier: "observes",
    mechanism: "nothing: Pi reports tool execution, it never asks first",
    gap: "a Pi agent's device launch cannot be refused, only counted once it boots",
  },
};

const UNKNOWN_PROVIDER_ENFORCEMENT: DeviceLaunchEnforcement = {
  tier: "observes",
  mechanism: "nothing: this provider has no interception point the daemon knows about",
  gap: "its device launches cannot be refused, only counted once they boot",
};

/**
 * A derived provider runs the base provider's client against the same machine and the same
 * devices, so it is enforced identically — a second Claude account is still gated by the hook.
 * `buildProviderRegistry` names them freely, so the base id is recovered from the prefix the
 * ACP branch uses plus an explicit `extends` when the caller has one.
 */
export function resolveDeviceLaunchEnforcement(
  providerId: string | undefined,
  extendsProviderId?: string | undefined,
): DeviceLaunchEnforcement {
  if (providerId && providerId in ENFORCEMENT_BY_PROVIDER) {
    return ENFORCEMENT_BY_PROVIDER[providerId] as DeviceLaunchEnforcement;
  }
  if (extendsProviderId && extendsProviderId in ENFORCEMENT_BY_PROVIDER) {
    return ENFORCEMENT_BY_PROVIDER[extendsProviderId] as DeviceLaunchEnforcement;
  }
  // A custom ACP provider the registry built from `extends: "acp"`: it speaks ACP, so it is
  // gated exactly like the named ACP providers above.
  if (extendsProviderId === "acp") {
    return ENFORCEMENT_BY_PROVIDER.copilot as DeviceLaunchEnforcement;
  }
  return UNKNOWN_PROVIDER_ENFORCEMENT;
}

/** One sentence an agent can act on, for the `device_status` tool and the checkout result. */
export function describeDeviceLaunchEnforcement(enforcement: DeviceLaunchEnforcement): string {
  switch (enforcement.tier) {
    case "refuses":
      return `Your device launches are refused when there is no slot, through ${enforcement.mechanism}. Call device_checkout first and you will never see a refusal.`;
    case "asks":
      return `Your device launches are refused only when you ask first, through ${enforcement.mechanism} — ${enforcement.gap}. Call device_checkout yourself; it is the only thing holding the cap for you.`;
    case "observes":
      return `Nothing refuses your device launches: ${enforcement.mechanism}. A device you boot still fills a slot for every other agent, so calling device_checkout is the only thing holding the cap for you.`;
  }
}
