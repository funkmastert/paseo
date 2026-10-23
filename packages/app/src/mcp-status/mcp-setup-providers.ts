/**
 * What the setup forms know about particular providers (docs/mcp-gateway.md "Setting up a server
 * that cannot sign in"). The mechanism is generic: a form for a hand-made OAuth app's credentials,
 * and a form for a local server run with a token. Everything provider-shaped lives in this one
 * table, keyed by the server's name in the gateway config, so a third server is a new entry.
 * The daemon owns the other half: which local server a preset id runs
 * (packages/server/src/server/mcp-gateway/local-server-presets.ts).
 */

/** The user scopes the Slack app asks for: everything Slack's MCP server reads with, nothing it
 * writes with. From the scope list on https://docs.slack.dev/ai/slack-mcp-server, tool by tool,
 * checked 2026-10-22. No `chat:write`, `files:write`, `canvases:write`, `reactions:write` or any
 * other `:write`: agents never post to Slack unasked, and a scope the app lacks cannot be used. */
export const SLACK_USER_SCOPES: readonly string[] = [
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "mpim:history",
  "mpim:read",
  "search:read.public",
  "search:read.private",
  "search:read.mpim",
  "search:read.im",
  "search:read.files",
  "search:read.users",
  "users:read",
  "users:read.email",
  "files:read",
  "canvases:read",
  "lists:read",
  "reactions:read",
  "emoji:read",
];

export const SLACK_APP_NAME = "Paseo MCP";
const SLACK_APP_DESCRIPTION = "Read-only Slack access for Paseo's MCP gateway";
const SLACK_NEW_APP_URL = "https://api.slack.com/apps";

/** The app manifest Slack's "create app from manifest" flow reads. */
export function buildSlackAppManifest(redirectUrl: string): object {
  return {
    display_information: { name: SLACK_APP_NAME, description: SLACK_APP_DESCRIPTION },
    oauth_config: {
      redirect_urls: [redirectUrl],
      scopes: { user: [...SLACK_USER_SCOPES] },
    },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

/** Opens Slack's app creation with the manifest prefilled. */
export function buildSlackAppUrl(redirectUrl: string): string {
  const manifest = encodeURIComponent(JSON.stringify(buildSlackAppManifest(redirectUrl)));
  return `${SLACK_NEW_APP_URL}?new_app=1&manifest_json=${manifest}`;
}

/** The scope string stored beside the credentials: the same list the manifest grants. */
export function slackScopeString(): string {
  return SLACK_USER_SCOPES.join(" ");
}

export interface McpSetupProvider {
  /** The server name in `mcpGateway`. */
  name: string;
  /** How the provider is written in the form's sentences; the strip's row keeps the raw name. */
  displayName: string;
  /** i18n key suffix under `mcpStatus.setup.providers` for this provider's own wording. */
  copyKey: string;
  localToken?: {
    /** The daemon's local-server preset id. */
    preset: string;
    /** Where the person gets a token. */
    tokenUrl: string;
  };
  clientCredentials?: {
    /** Opens the provider's app creation with everything prefilled. */
    buildAppUrl: (redirectUrl: string) => string;
    /** Stored beside the credentials; read-only by construction. */
    scope: string;
  };
}

export const MCP_SETUP_PROVIDERS: Readonly<Record<string, McpSetupProvider>> = {
  figma: {
    name: "figma",
    displayName: "Figma",
    copyKey: "figma",
    localToken: { preset: "figma", tokenUrl: "https://www.figma.com/settings" },
  },
  slack: {
    name: "slack",
    displayName: "Slack",
    copyKey: "slack",
    clientCredentials: { buildAppUrl: buildSlackAppUrl, scope: slackScopeString() },
  },
};

export function getSetupProvider(serverName: string): McpSetupProvider | undefined {
  return Object.hasOwn(MCP_SETUP_PROVIDERS, serverName)
    ? MCP_SETUP_PROVIDERS[serverName]
    : undefined;
}
