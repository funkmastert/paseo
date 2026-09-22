import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import {
  OAuthClientInformationFullSchema,
  OAuthTokensSchema,
  type OAuthClientInformationFull,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";

interface LoggerLike {
  child(bindings: Record<string, unknown>): LoggerLike;
  warn(...args: unknown[]): void;
}

const PreregisteredOAuthClientSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
});

// KTD4: OAuth token records carry the SDK's own token/registration shapes verbatim (no
// reshaping) plus the PKCE verifier saved between authorization-start and callback-exchange.
// Static-auth records store header VALUES here — never in persisted-config.ts — because
// `MutableDaemonConfig` (config's live-toggle mirror) is broadcast in full to every client.
const OAuthTokenRecordSchema = z.object({
  auth: z.literal("oauth"),
  tokens: OAuthTokensSchema.optional(),
  clientInformation: OAuthClientInformationFullSchema.optional(),
  /** Credentials of an OAuth app registered with the upstream by hand, for servers whose
   * authorization server has no dynamic-registration endpoint (Slack and friends). Kept here
   * rather than config because `clientSecret` is a secret and config is broadcast to every
   * client; config references the server by name and this file holds the credential, exactly as
   * for static-auth headers. Deliberately not the SDK's `OAuthClientInformationFull` shape —
   * that one requires `redirect_uris`, so a hand-written `{client_id, client_secret}` would fail
   * validation and take the whole token file down with it (readAll fails closed to empty). */
  clientCredentials: PreregisteredOAuthClientSchema.optional(),
  codeVerifier: z.string().optional(),
  /** Non-auth headers an OAuth upstream additionally requires (e.g. zeeq's
   * `x-zeeq-prompts-repo` selector). Kept here rather than config for the same
   * broadcast reason as static headers, even when the value isn't secret. */
  extraHeaders: z.record(z.string(), z.string()).optional(),
});

const StaticTokenRecordSchema = z.object({
  auth: z.literal("static"),
  headers: z.record(z.string(), z.string()),
});

const McpGatewayTokenRecordSchema = z.discriminatedUnion("auth", [
  OAuthTokenRecordSchema,
  StaticTokenRecordSchema,
]);

const McpGatewayTokenFileSchema = z.object({
  version: z.literal(1),
  servers: z.record(z.string(), McpGatewayTokenRecordSchema),
});

export type PreregisteredOAuthClient = z.infer<typeof PreregisteredOAuthClientSchema>;
export type McpGatewayOAuthTokenRecord = z.infer<typeof OAuthTokenRecordSchema>;
export type McpGatewayStaticTokenRecord = z.infer<typeof StaticTokenRecordSchema>;
export type McpGatewayTokenRecord = z.infer<typeof McpGatewayTokenRecordSchema>;
export type McpGatewayTokenFile = z.infer<typeof McpGatewayTokenFileSchema>;

const TOKENS_RELATIVE_PATH = path.join("mcp-gateway", "tokens.json");
const EMPTY_TOKEN_FILE: McpGatewayTokenFile = { version: 1, servers: {} };

/**
 * Private 0600 file store for MCP gateway credentials (KTD4), keyed by server
 * name. Read-modify-write on every call: the file is small and touched
 * infrequently (connect attempts, auth completions), so there is no
 * in-memory cache to keep in sync across gateway restarts.
 *
 * A malformed or unreadable file fails closed to "no tokens" rather than
 * throwing — callers (the gateway's connect logic) treat that identically to
 * a server that was never authorized, landing it in `needs-auth`.
 */
export class McpGatewayTokenStore {
  private readonly filePath: string;
  private readonly logger: LoggerLike | undefined;

  constructor(paseoHome: string, logger?: LoggerLike) {
    this.filePath = path.join(paseoHome, TOKENS_RELATIVE_PATH);
    this.logger = logger?.child({ module: "mcp-gateway-token-store" });
  }

  /** Where hand-written credentials go. Named in the error that asks for them, resolved rather
   * than as `$PASEO_HOME/…` so the person reading it can open the file without resolving it. */
  get credentialsPath(): string {
    return this.filePath;
  }

  private readAll(): McpGatewayTokenFile {
    if (!existsSync(this.filePath)) {
      return EMPTY_TOKEN_FILE;
    }
    try {
      ensurePrivateFile(this.filePath);
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = McpGatewayTokenFileSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        this.logger?.warn(
          { filePath: this.filePath, issues: parsed.error.issues },
          "Malformed MCP gateway token file, treating as empty",
        );
        return EMPTY_TOKEN_FILE;
      }
      return parsed.data;
    } catch (error) {
      this.logger?.warn(
        { err: error, filePath: this.filePath },
        "Failed to read MCP gateway token file, treating as empty",
      );
      return EMPTY_TOKEN_FILE;
    }
  }

  private writeAll(file: McpGatewayTokenFile): void {
    writePrivateFileAtomicSync(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
  }

  private setRecord(serverName: string, record: McpGatewayTokenRecord): void {
    const file = this.readAll();
    this.writeAll({ ...file, servers: { ...file.servers, [serverName]: record } });
  }

  private getOAuthRecord(serverName: string): McpGatewayOAuthTokenRecord | undefined {
    const record = this.readAll().servers[serverName];
    return record?.auth === "oauth" ? record : undefined;
  }

  private patchOAuthRecord(
    serverName: string,
    patch: Partial<Omit<McpGatewayOAuthTokenRecord, "auth">>,
  ): void {
    this.setRecord(serverName, {
      ...(this.getOAuthRecord(serverName) ?? { auth: "oauth" }),
      ...patch,
    });
  }

  getOAuthTokens(serverName: string): OAuthTokens | undefined {
    return this.getOAuthRecord(serverName)?.tokens;
  }

  saveOAuthTokens(serverName: string, tokens: OAuthTokens): void {
    this.patchOAuthRecord(serverName, { tokens });
  }

  getClientInformation(serverName: string): OAuthClientInformationFull | undefined {
    return this.getOAuthRecord(serverName)?.clientInformation;
  }

  saveClientInformation(serverName: string, clientInformation: OAuthClientInformationFull): void {
    this.patchOAuthRecord(serverName, { clientInformation });
  }

  /** Drops a dynamic registration so the next sign-in registers afresh. */
  forgetClientInformation(serverName: string): void {
    const record = this.getOAuthRecord(serverName);
    if (!record?.clientInformation) {
      return;
    }
    const { clientInformation: _dropped, ...rest } = record;
    this.setRecord(serverName, rest);
  }

  getClientCredentials(serverName: string): PreregisteredOAuthClient | undefined {
    return this.getOAuthRecord(serverName)?.clientCredentials;
  }

  getCodeVerifier(serverName: string): string | undefined {
    return this.getOAuthRecord(serverName)?.codeVerifier;
  }

  saveCodeVerifier(serverName: string, codeVerifier: string): void {
    this.patchOAuthRecord(serverName, { codeVerifier });
  }

  getOAuthExtraHeaders(serverName: string): Record<string, string> | undefined {
    return this.getOAuthRecord(serverName)?.extraHeaders;
  }

  saveOAuthExtraHeaders(serverName: string, extraHeaders: Record<string, string>): void {
    this.patchOAuthRecord(serverName, { extraHeaders });
  }

  getStaticHeaders(serverName: string): Record<string, string> | undefined {
    const record = this.readAll().servers[serverName];
    return record?.auth === "static" ? record.headers : undefined;
  }

  saveStaticHeaders(serverName: string, headers: Record<string, string>): void {
    this.setRecord(serverName, { auth: "static", headers });
  }

  deleteServer(serverName: string): void {
    const file = this.readAll();
    if (!(serverName in file.servers)) {
      return;
    }
    const servers = { ...file.servers };
    delete servers[serverName];
    this.writeAll({ ...file, servers });
  }
}
