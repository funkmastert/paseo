import type { PluginBeforeRequests } from "@getpaseo/plugin/server";
import { MCP_SCOPE_LABEL } from "../shared/role-policy-schema";
import { mcpScopeLabelValue, type McpDecision } from "./mcp-scope";

type CreateRequest = PluginBeforeRequests["agent.create"];

/**
 * Writes the classifier's MCP decision (server/mcp-scope.ts) onto a create
 * request as the `paseo.mcp-scope` label. Returns undefined when the request
 * already carries the right value.
 *
 * A label and nothing else, because the daemon running this plugin can be
 * older than the plugin: the packaged app lags the checkout the plugin loads
 * from. An older daemon ignores a label it does not know, so the agent keeps
 * every server, as before. `config.providerOptions` would not degrade that
 * way: the Claude options schema is strict and re-validated on create and
 * resume, so an unknown key there fails every child create. The daemon
 * derives both halves from the label on every launch: which gateway servers
 * to broker, and whether to switch the account's claude.ai connectors off
 * (`packages/server/src/server/agent/runtime-mcp-config.ts`).
 *
 * The label is stripped when the decision is unscoped, so a caller-supplied
 * value can never scope an agent the classifier did not.
 */
export function withMcpScope(request: CreateRequest, decision: McpDecision): CreateRequest | undefined {
  const extended = request as CreateRequest & { labels?: Record<string, string> };
  const labels = extended.labels ?? {};
  const wanted = mcpScopeLabelValue(decision);
  if (labels[MCP_SCOPE_LABEL] === wanted) {
    return undefined;
  }
  const nextLabels = { ...labels };
  if (wanted === undefined) {
    delete nextLabels[MCP_SCOPE_LABEL];
  } else {
    nextLabels[MCP_SCOPE_LABEL] = wanted;
  }
  return { ...request, labels: nextLabels } as CreateRequest;
}
