import { Text } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsSection } from "@getpaseo/plugin/client/ui";
import { rolePolicyFamilies } from "../../shared/role-policy-schema";
import { AddRoleButton } from "./add-role-button";
import { AgentRoleMappingsSection } from "./agent-role-mappings-section";
import { MalformedBanner } from "./limits-banner";
import { ModelBudgetSection } from "./model-budget-section";
import { RefreshModelsButton } from "./refresh-models-button";
import { RoleCard } from "./role-card";
import { TestRoleName } from "./test-role-name";
import { ThinkingSection } from "./thinking-section";
import { useModelCatalog } from "./use-model-catalog";
import { useRecentAgentTypes } from "./use-recent-agent-types";
import { useRoleModelPolicy } from "./use-role-model-policy";

/** Registered via `client.addSettingsScreen({ id: "agent-model-policy", ... })` in index.client.tsx. */
export function AgentModelPolicyScreen({ theme }: PluginSurfaceProps) {
  const load = useRoleModelPolicy();
  const recentAgentTypes = useRecentAgentTypes();
  const referencedFamilies = load.status === "ready" ? rolePolicyFamilies(load.state.policy) : [];
  const catalog = useModelCatalog(referencedFamilies);

  if (load.status === "loading") {
    return <Text style={{ color: theme.colors.foreground }}>Loading policy…</Text>;
  }
  if (load.status === "error") {
    return (
      <SettingsSection title="Agent Model Policy" testID="agent-model-policy-error">
        <Text style={{ color: theme.colors.statusDanger }}>{load.error}</Text>
        <SettingsAction label="Reload" actionLabel="Try again" onPress={load.reload} />
      </SettingsSection>
    );
  }

  const { model, state } = load;

  return (
    <>
      {state.malformed ? <MalformedBanner error={state.malformedError} onReload={load.reload} theme={theme} /> : null}

      <SettingsSection
        title="Roles"
        info={
          <Text style={{ color: theme.colors.foregroundMuted }}>
            Standard roles first, then custom roles in creation order. Each role picks a model and a set of tools; the
            account pool still decides which account runs it, so a model listed without a provider survives one account
            being capped.
          </Text>
        }
      >
        <RefreshModelsButton catalog={catalog} />
        {state.policy.roles.map((role) => (
          <RoleCard key={role.id} roleId={role.id} model={model} state={state} catalog={catalog} theme={theme} />
        ))}
        <AddRoleButton
          canAddRole={state.canAddRole}
          saving={state.saving}
          malformed={state.malformed}
          onAdd={(name) => void model.addRole(name)}
        />
      </SettingsSection>

      <ThinkingSection model={model} state={state} theme={theme} />

      <ModelBudgetSection model={model} state={state} theme={theme} />

      <AgentRoleMappingsSection model={model} state={state} recentAgentTypes={recentAgentTypes} theme={theme} />

      <TestRoleName theme={theme} />
    </>
  );
}
