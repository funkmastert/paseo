/**
 * The device-gate chain every provider's PreToolUse hook ultimately reaches, sitting as the
 * `inner` of `bootstrap.ts`'s native build gate: the emulator/simulator slot cap's boot gate
 * (`DeviceLeaseManager.gateLaunch`), then that same cap's install gate (`gateInstall`, for a
 * command that uses a running emulator or simulator rather than booting one), then the
 * physical-device install gate (`PhysicalDeviceLeaseManager.gateInstall`). A refusal from any
 * step wins over an allow from the step before it; a command only one gate recognizes falls
 * through every other step as an allow, since an unrecognized command is nothing that gate
 * protects.
 *
 * Extracted out of `bootstrap.ts` so this composition — the order, the short-circuiting, which
 * gate a given command actually reaches — can be exercised against real gate instances in a
 * test, rather than only through the full daemon's wiring.
 */

import type { DeviceLaunchGateDecision } from "./device-lease-manager.js";

export interface ComposedDeviceGateDeps {
  /** The emulator/simulator slot cap's boot gate — refuses booting a NEW device past the cap. */
  bootGate: {
    gateLaunch(input: { agentId: string; command: string }): Promise<DeviceLaunchGateDecision>;
  };
  /** That same cap's install gate — refuses installing/launching/testing onto a RUNNING emulator
   * or simulator another agent holds. */
  emulatorInstallGate: {
    gateInstall(input: { agentId: string; command: string }): Promise<DeviceLaunchGateDecision>;
  };
  /** The physical-device install gate — refuses the same onto a connected phone or paired
   * iPhone another agent holds. */
  physicalInstallGate: {
    gateInstall(input: { agentId: string; command: string }): Promise<DeviceLaunchGateDecision>;
  };
}

/**
 * Composes the three gates into the one `gateLaunch` a provider's hook calls. Each step runs in
 * order and returns its own decision unchanged on a deny; nothing here decides anything itself.
 */
export function createComposedDeviceLaunchGate(deps: ComposedDeviceGateDeps): {
  gateLaunch(input: { agentId: string; command: string }): Promise<DeviceLaunchGateDecision>;
} {
  return {
    async gateLaunch(input) {
      const capDecision = await deps.bootGate.gateLaunch(input);
      if (capDecision.decision === "deny") return capDecision;
      const emulatorInstallDecision = await deps.emulatorInstallGate.gateInstall(input);
      if (emulatorInstallDecision.decision === "deny") return emulatorInstallDecision;
      return await deps.physicalInstallGate.gateInstall(input);
    },
  };
}
