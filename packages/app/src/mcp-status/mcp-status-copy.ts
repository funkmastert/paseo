import type { TFunction } from "i18next";
import { showsReporterProvenance } from "./mcp-status-strip-model";
import type {
  McpStatusActionFailure,
  McpStatusRow,
  McpStatusRowAnnotation,
} from "./mcp-status-strip-model";

/**
 * Who is affected, or nothing when saying so adds nothing (`showsReporterProvenance`). When
 * every reporter is on one provider the count is not the story — fifteen agents on one
 * signed-out account is one problem, and "reported by 15 agents" makes a single daemon-side
 * cause read as fifteen. Only genuinely independent reporters get a count.
 */
export function reportedByText(t: TFunction, row: McpStatusRow): string | null {
  const annotation = row.annotation;
  if (!annotation || !showsReporterProvenance(row)) {
    return null;
  }
  return describeReporters(t, annotation);
}

function describeReporters(t: TFunction, annotation: McpStatusRowAnnotation): string {
  const provider = annotation.providerIds.length === 1 ? annotation.providerIds[0] : null;
  if (!provider) {
    return t("mcpStatus.reportedByCount", { count: annotation.reporterCount });
  }
  return annotation.reporterCount > 1
    ? t("mcpStatus.reportedOn", { provider })
    : t("mcpStatus.reportedByOn", { agent: annotation.agentLabel, provider });
}

const FAILURE_COPY_KEY_BY_REASON: Record<string, string> = {
  gateway_disabled: "mcpStatus.failure.gatewayDisabled",
  unknown_agent: "mcpStatus.failure.unknownAgent",
  provider_has_no_config: "mcpStatus.failure.providerHasNoConfig",
  account_signed_out: "mcpStatus.failure.accountSignedOut",
  server_not_in_config: "mcpStatus.failure.serverNotInConfig",
  server_is_local: "mcpStatus.failure.serverIsLocal",
  adopt_failed: "mcpStatus.failure.adoptFailed",
  unknown_server: "mcpStatus.failure.unknownServer",
  static_auth: "mcpStatus.failure.staticAuth",
  no_redirect_url: "mcpStatus.failure.noRedirectUrl",
  client_not_registered: "mcpStatus.failure.clientNotRegistered",
  server_rejected: "mcpStatus.failure.serverRejected",
  server_unreachable: "mcpStatus.failure.serverUnreachable",
  authorization_failed: "mcpStatus.failure.authorizationFailed",
};

/**
 * What went wrong, in the caller's terms. A daemon that sends no reason — or one this build has
 * no copy for — gets its own sentence verbatim rather than a category the app guessed at.
 */
export function failureText(
  t: TFunction,
  row: McpStatusRow,
  failure: McpStatusActionFailure,
): string {
  const key = failure.reason ? FAILURE_COPY_KEY_BY_REASON[failure.reason] : undefined;
  if (!key) {
    return failure.error;
  }
  return t(key, {
    name: row.name,
    provider: row.annotation?.agentProvider ?? "",
    error: failure.error,
  });
}

/** One labelled host fact under a failure: a URI to register, a file to edit, a line to paste. */
export interface McpStatusRemedyLine {
  key: string;
  label: string;
  value: string;
}

/**
 * The JSON a person adds to the host's token file to register a hand-made OAuth app. Built
 * here, not in a translation: it is code, and it has to stay valid in every language.
 */
export function clientCredentialsSnippet(serverName: string): string {
  return JSON.stringify(
    {
      servers: {
        [serverName]: {
          auth: "oauth",
          clientCredentials: { clientId: "…", clientSecret: "…" },
        },
      },
    },
    null,
    2,
  );
}

/**
 * The parts of a failure worth showing under its sentence, in the order someone would work
 * through them. Empty when the daemon sent nothing to act on, which is most failures.
 */
export function remedyLines(
  t: TFunction,
  row: McpStatusRow,
  failure: McpStatusActionFailure,
): McpStatusRemedyLine[] {
  const lines: McpStatusRemedyLine[] = [];
  if (failure.remedyRedirectUrl) {
    lines.push({
      key: "redirectUrl",
      label: t("mcpStatus.remedy.redirectUrl"),
      value: failure.remedyRedirectUrl,
    });
  }
  if (failure.remedyPath) {
    lines.push({ key: "path", label: t("mcpStatus.remedy.path"), value: failure.remedyPath });
  }
  if (failure.reason === "client_not_registered") {
    lines.push({
      key: "snippet",
      label: t("mcpStatus.remedy.snippet"),
      value: clientCredentialsSnippet(row.name),
    });
  }
  if (failure.remedyCommand) {
    lines.push({
      key: "command",
      label: t("mcpStatus.remedy.command"),
      value: failure.remedyCommand,
    });
  }
  return lines;
}

/** Everything the row is saying, as one block a person can paste somewhere readable. */
export function failureClipboardText(
  t: TFunction,
  row: McpStatusRow,
  failure: McpStatusActionFailure,
): string {
  const parts = [`${row.name}: ${failureText(t, row, failure)}`];
  for (const line of remedyLines(t, row, failure)) {
    parts.push(`${line.label}:\n${line.value}`);
  }
  return parts.join("\n\n");
}
