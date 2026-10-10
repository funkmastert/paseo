import type { Href } from "expo-router";
import { buildHostRootRoute, buildHostWorkspaceOpenRoute } from "@/utils/host-routes";

type NotificationData = Record<string, unknown> | null | undefined;
type NotificationRoute = Extract<Href, string>;

function readNonEmptyString(data: NotificationData, key: string): string | null {
  const value = data?.[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveNotificationTarget(data: NotificationData): {
  serverId: string | null;
  agentId: string | null;
  workspaceId: string | null;
  terminalId: string | null;
} {
  return {
    serverId: readNonEmptyString(data, "serverId"),
    agentId: readNonEmptyString(data, "agentId"),
    workspaceId: readNonEmptyString(data, "workspaceId"),
    terminalId: readNonEmptyString(data, "terminalId"),
  };
}

export function buildNotificationRoute(data: NotificationData): NotificationRoute {
  const { serverId, agentId, workspaceId, terminalId } = resolveNotificationTarget(data);
  if (serverId && workspaceId && agentId) {
    return buildHostWorkspaceOpenRoute(serverId, workspaceId, `agent:${agentId}`);
  }
  if (serverId && workspaceId && terminalId) {
    return buildHostWorkspaceOpenRoute(serverId, workspaceId, `terminal:${terminalId}`);
  }
  if (serverId) {
    return buildHostRootRoute(serverId);
  }
  return "/" as const;
}

/** An https link the notification asks to open outside the app (a shared build), or null. */
function resolveNotificationExternalUrl(data: NotificationData): string | null {
  const value = readNonEmptyString(data, "externalUrl");
  if (!value) {
    return null;
  }
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

export type NotificationTapAction =
  | { kind: "open-external"; url: string }
  | { kind: "open-agent"; serverId: string; workspaceId: string; agentId: string }
  | { kind: "navigate"; route: NotificationRoute };

/**
 * What tapping a notification does. A shared build's push carries an https `externalUrl` that
 * opens in the browser (the APK download or the iOS install page); any other scheme is ignored and
 * the tap routes in the app as usual.
 */
export function resolveNotificationTapAction(data: NotificationData): NotificationTapAction {
  const url = resolveNotificationExternalUrl(data);
  if (url) {
    return { kind: "open-external", url };
  }
  const { serverId, workspaceId, agentId } = resolveNotificationTarget(data);
  if (serverId && workspaceId && agentId) {
    return { kind: "open-agent", serverId, workspaceId, agentId };
  }
  return { kind: "navigate", route: buildNotificationRoute(data) };
}
