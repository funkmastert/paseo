import { useState } from "react";
import { Text } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsInput, SettingsSection } from "@getpaseo/plugin/client/ui";
import { roleModelPolicyRpc, type RoleModelPolicyExplainResult } from "../../shared/role-policy-rpc";

export interface TestRoleNameProps {
  theme: PluginSurfaceProps["theme"];
}

/** A bare ref has no provider: say which one, rather than printing "undefined/model". */
function describeTarget(result: RoleModelPolicyExplainResult): string {
  return result.provider === undefined
    ? `${result.model} on whichever pooled account is healthy`
    : `${result.provider}/${result.model}`;
}

function describeTools(result: RoleModelPolicyExplainResult): string {
  return result.deniedTools.length === 0 ? "" : ` Tools denied: ${result.deniedTools.join(", ")}.`;
}

function describeOutcome(result: RoleModelPolicyExplainResult): string {
  const tierLabel = { 1: "exact mapping", 2: "declared role label", 3: "automatic classification", 4: "default" }[result.tier];
  const tools = describeTools(result);
  switch (result.outcome) {
    case "unconfigured":
      return `→ ${result.roleName} (via ${tierLabel}), no model configured: the model is left as requested.${tools}`;
    case "selected":
      return `→ ${result.roleName} (via ${tierLabel}): would route to ${describeTarget(result)}.${tools}`;
    case "unavailable":
      return `→ ${result.roleName} (via ${tierLabel}): no eligible model right now; falls back to ${describeTarget(result)}.${tools}`;
  }
}

/** Lightweight diagnostic in place of PiSesh's `/worker-models` — simulates resolution for a hypothetical agent-type/title without creating an agent. */
export function TestRoleName({ theme }: TestRoleNameProps) {
  const explain = useRpc(roleModelPolicyRpc.explain);
  const [agentType, setAgentType] = useState("");
  const [title, setTitle] = useState("");
  const [result, setResult] = useState<RoleModelPolicyExplainResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <SettingsSection title="Test This Name" testID="test-role-name-section">
      <SettingsInput label="Agent-type / title" onChangeText={setAgentType} placeholder="e.g. ce-code-reviewer" testID="test-role-name-agent-type" />
      <SettingsInput label="Prompt/title text (optional)" onChangeText={setTitle} placeholder="used for automatic classification" testID="test-role-name-title" />
      <SettingsAction
        label="Resolution preview"
        actionLabel="Test"
        onPress={() => {
          setError(null);
          explain({
            agentType: agentType.trim().length > 0 ? agentType.trim() : undefined,
            title: title.trim().length > 0 ? title.trim() : undefined,
          })
            .then(setResult)
            .catch((err) => setError(err instanceof Error ? err.message : String(err)));
        }}
        testID="test-role-name-action"
      />
      {result ? <Text style={{ color: theme.colors.foreground }}>{describeOutcome(result)}</Text> : null}
      {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
    </SettingsSection>
  );
}
