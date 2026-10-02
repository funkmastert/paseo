import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { confirmDialog } from "@/utils/confirm-dialog";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { DeviceStatusStripView, type DeviceEnforceToggle } from "./device-status-strip-view";
import { useDeviceActions, useDeviceStatus } from "./use-device-status";

/** The "Enforce" switch's daemon-config round trip. It snaps back to whatever the daemon
 * reports: the next push always wins. */
function useEnforceToggle(serverId: string | null, onError: (message: string) => void) {
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [pending, setPending] = useState(false);
  const onValueChange = useCallback(
    (enforce: boolean) => {
      void (async () => {
        setPending(true);
        try {
          await patchConfig({ deviceLeases: { dryRun: !enforce } });
        } catch (error) {
          onError(error instanceof Error ? error.message : String(error));
        } finally {
          setPending(false);
        }
      })();
    },
    [patchConfig, onError],
  );
  const toggle: DeviceEnforceToggle = { canToggle: config !== null, pending, onValueChange };
  return toggle;
}

/**
 * Host-scoped Devices section, mounted beside McpStatusStrip in the sidebar: wires
 * DeviceStatusStripView to the daemon. Every number came from the daemon's process scan
 * (docs/device-leases.md), so a simulator Tyler booted by hand appears with no holder rather
 * than not appearing. Renders nothing on a daemon without the cap, or when there is no device
 * and nobody waiting.
 */
export function DeviceStatusStrip() {
  const { t } = useTranslation();
  const toast = useToast();
  const { serverId, supportsDeviceStatus, supportsDeviceManagement, model } = useDeviceStatus();
  const { releaseLease, setReservation, shutdown } = useDeviceActions(serverId);
  // Collapsed by default, like the MCP strip: chrome state, not persisted.
  const [expanded, setExpanded] = useState(false);
  const handleToggle = useCallback(() => setExpanded((previous) => !previous), []);

  const reportFailure = useCallback(
    (message: string) => toast.error(t("deviceStatus.actionFailed", { message })),
    [toast, t],
  );
  const enforceToggle = useEnforceToggle(serverId, reportFailure);

  const handleOpenAgent = useCallback(
    (agentId: string) => {
      if (serverId) navigateToAgent({ serverId, agentId });
    },
    [serverId],
  );
  const handleRelease = useCallback(
    async (deviceId: string) => {
      try {
        await releaseLease(deviceId);
      } catch (error) {
        reportFailure(error instanceof Error ? error.message : String(error));
      }
    },
    [releaseLease, reportFailure],
  );
  const handleSetReservation = useCallback(
    async (deviceId: string, reserved: boolean) => {
      try {
        await setReservation(deviceId, reserved);
      } catch (error) {
        reportFailure(error instanceof Error ? error.message : String(error));
      }
    },
    [setReservation, reportFailure],
  );
  const handleShutdown = useCallback(
    async (deviceId: string) => {
      const confirmed = await confirmDialog({
        title: t("deviceStatus.confirmShutdown.title"),
        message: t("deviceStatus.confirmShutdown.message"),
        confirmLabel: t("deviceStatus.confirmShutdown.confirmLabel"),
        destructive: true,
      });
      if (!confirmed) return;

      try {
        let result = await shutdown({ deviceId });
        if (result.status === "needs-confirmation") {
          const confirmedAnyway = await confirmDialog({
            title: t("deviceStatus.confirmShutdown.midTurnTitle"),
            message:
              result.message ?? t("deviceStatus.confirmShutdown.midTurnMessage", { agent: "" }),
            confirmLabel: t("deviceStatus.confirmShutdown.confirmLabel"),
            destructive: true,
          });
          if (!confirmedAnyway) return;
          result = await shutdown({ deviceId, confirmMidTurnHolder: true });
        }
        if (result.status === "failed") reportFailure(result.message ?? result.status);
      } catch (error) {
        reportFailure(error instanceof Error ? error.message : String(error));
      }
    },
    [shutdown, t, reportFailure],
  );

  if (!supportsDeviceStatus || !model.hasData) {
    return null;
  }

  return (
    <DeviceStatusStripView
      model={model}
      canManage={supportsDeviceManagement}
      expanded={expanded}
      onToggleExpanded={handleToggle}
      enforceToggle={enforceToggle}
      onOpenAgent={handleOpenAgent}
      onRelease={handleRelease}
      onSetReservation={handleSetReservation}
      onShutdown={handleShutdown}
    />
  );
}
