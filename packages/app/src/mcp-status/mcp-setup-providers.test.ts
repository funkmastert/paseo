import { describe, expect, it } from "vitest";
import {
  buildSlackAppManifest,
  buildSlackAppUrl,
  getSetupProvider,
  SLACK_APP_NAME,
  SLACK_USER_SCOPES,
  slackScopeString,
} from "./mcp-setup-providers";

const REDIRECT = "http://localhost:6767/mcp/gateway/oauth/callback";

function manifestFromUrl(url: string): {
  display_information: { name: string };
  oauth_config: { redirect_urls: string[]; scopes: { user: string[]; bot?: string[] } };
} {
  const parsed = new URL(url);
  return JSON.parse(parsed.searchParams.get("manifest_json") ?? "null");
}

describe("Slack app manifest", () => {
  it("opens Slack's new-app flow with the manifest in the query", () => {
    const url = new URL(buildSlackAppUrl(REDIRECT));
    expect(`${url.origin}${url.pathname}`).toBe("https://api.slack.com/apps");
    expect(url.searchParams.get("new_app")).toBe("1");
    expect(JSON.parse(url.searchParams.get("manifest_json") ?? "null")).toEqual(
      buildSlackAppManifest(REDIRECT),
    );
  });

  it("names the app Paseo MCP and sets the redirect it was given", () => {
    const manifest = manifestFromUrl(buildSlackAppUrl(REDIRECT));
    expect(manifest.display_information.name).toBe("Paseo MCP");
    expect(SLACK_APP_NAME).toBe("Paseo MCP");
    expect(manifest.oauth_config.redirect_urls).toEqual([REDIRECT]);
  });

  it("follows the daemon's port, not a fixed one", () => {
    const manifest = manifestFromUrl(buildSlackAppUrl("http://localhost:7123/cb"));
    expect(manifest.oauth_config.redirect_urls).toEqual(["http://localhost:7123/cb"]);
  });

  it("asks for read-only user scopes and no bot scopes", () => {
    const manifest = manifestFromUrl(buildSlackAppUrl(REDIRECT));
    expect(manifest.oauth_config.scopes.user).toEqual([...SLACK_USER_SCOPES]);
    expect(manifest.oauth_config.scopes.bot).toBeUndefined();
  });

  it("never asks for a scope that writes", () => {
    for (const scope of SLACK_USER_SCOPES) {
      expect(scope).not.toMatch(/:write/);
      expect(scope).not.toBe("chat:write");
    }
    expect(SLACK_USER_SCOPES).toEqual(expect.arrayContaining(["channels:history", "users:read"]));
    expect(SLACK_USER_SCOPES).not.toContain("canvases:write");
    expect(SLACK_USER_SCOPES).not.toContain("files:write");
  });

  it("has no duplicate scopes, and the stored scope string is the same list", () => {
    expect(new Set(SLACK_USER_SCOPES).size).toBe(SLACK_USER_SCOPES.length);
    expect(slackScopeString().split(" ")).toEqual([...SLACK_USER_SCOPES]);
  });
});

describe("provider table", () => {
  it("figma runs a local server with a token", () => {
    const figma = getSetupProvider("figma");
    expect(figma?.localToken?.preset).toBe("figma");
    expect(figma?.localToken?.tokenUrl).toMatch(/^https:\/\/www\.figma\.com\//);
    expect(figma?.clientCredentials).toBeUndefined();
  });

  it("slack needs a hand-made OAuth app and stores the read-only scope with it", () => {
    const slack = getSetupProvider("slack");
    expect(slack?.clientCredentials?.scope).toBe(slackScopeString());
    expect(slack?.clientCredentials?.buildAppUrl(REDIRECT)).toBe(buildSlackAppUrl(REDIRECT));
    expect(slack?.localToken).toBeUndefined();
  });

  it("knows no one else, including inherited property names", () => {
    expect(getSetupProvider("linear")).toBeUndefined();
    expect(getSetupProvider("toString")).toBeUndefined();
  });

  it("the manifest builder is the table's builder", () => {
    expect(buildSlackAppManifest(REDIRECT)).toMatchObject({
      oauth_config: { redirect_urls: [REDIRECT] },
    });
  });
});
