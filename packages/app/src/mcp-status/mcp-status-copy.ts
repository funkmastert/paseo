import type { TFunction } from "i18next";
import type {
  McpStatusActionFailure,
  McpStatusRow,
  McpStatusRowAnnotation,
} from "./mcp-status-strip-model";

/**
 * Who is affected. When every reporter is on one provider the count is not the story — fifteen
 * agents on one signed-out account is one problem, and saying "reported by 15 agents" makes a
 * single daemon-side cause read as fifteen. Only genuinely independent reporters get a count.
 */
export function reportedByText(t: TFunction, annotation: McpStatusRowAnnotation): string {
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
