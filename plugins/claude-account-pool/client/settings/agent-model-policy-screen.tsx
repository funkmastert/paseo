import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsSection } from "@getpaseo/plugin/client/ui";
import { rolePolicyFamilies } from "../../shared/role-policy-schema";
import { AddRoleButton } from "./add-role-button";
import { AgentRoleMappingsSection } from "./agent-role-mappings-section";
import { ClassifierDecisionsSection } from "./classifier-decisions-section";
import { MalformedBanner } from "./limits-banner";
import { ModelBudgetSection } from "./model-budget-section";
import { RefreshModelsButton } from "./refresh-models-button";
import { RoleCard } from "./role-card";
import { TestRoleName } from "./test-role-name";
import { ThinkingSection } from "./thinking-section";
import { useModelCatalog } from "./use-model-catalog";
import { useRecentAgentTypes } from "./use-recent-agent-types";
import { useRoleModelPolicy } from "./use-role-model-policy";

type ScreenTab = "policy" | "decisions";

/**
 * A plain in-screen segmented control, not a second registered settings
 * screen or a host tab primitive (neither exists — `client.addSettingsScreen`
 * registers one flat component per screen, docs/plugins.md). KTD-6.
 */
function ScreenTabs({ tab, onChange, theme }: { tab: ScreenTab; onChange: (tab: ScreenTab) => void; theme: PluginSurfaceProps["theme"] }) {
  const tabs: Array<{ id: ScreenTab; label: string }> = [
    { id: "policy", label: "Policy" },
    { id: "decisions", label: "Decisions" },
  ];
  return (
    <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 12, paddingVertical: 8 }} testID="agent-model-policy-tabs">
      {tabs.map(({ id, label }) => {
        const active = id === tab;
        return (
          <Pressable
            key={id}
            onPress={() => onChange(id)}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: 6,
              backgroundColor: active ? theme.colors.accent : theme.colors.surface1,
            }}
            testID={`agent-model-policy-tab-${id}`}
          >
            <Text style={{ color: active ? theme.colors.accentForeground : theme.colors.foreground }}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Registered via `client.addSettingsScreen({ id: "agent-model-policy", ... })` in index.client.tsx. */
export function AgentModelPolicyScreen(props: PluginSurfaceProps) {
  const { theme } = props;
  const [tab, setTab] = useState<ScreenTab>("policy");
  const load = useRoleModelPolicy();
  const recentAgentTypes = useRecentAgentTypes();
  const referencedFamilies = load.status === "ready" ? rolePolicyFamilies(load.state.policy) : [];
  const catalog = useModelCatalog(referencedFamilies);

  // Every pool row is checked against its family's catalog, so load the
  // families the policy references up front rather than when the Add-model
  // picker is first opened. Each is asked for once: a failed load must not
  // retry on every render.
  const requestedFamilies = useRef(new Set<string>());
  const referencedKey = referencedFamilies.join(",");
  useEffect(() => {
    for (const family of referencedKey.split(",").filter((entry) => entry.length > 0)) {
      if (!requestedFamilies.current.has(family)) {
        requestedFamilies.current.add(family);
        catalog.ensureFamily(family);
      }
    }
  }, [referencedKey, catalog]);

  if (tab === "decisions") {
    return (
      <>
        <ScreenTabs tab={tab} onChange={setTab} theme={theme} />
        <ClassifierDecisionsSection {...props} />
      </>
    );
  }

  if (load.status === "loading") {
    return (
      <>
        <ScreenTabs tab={tab} onChange={setTab} theme={theme} />
        <Text style={{ color: theme.colors.foreground }}>Loading policy…</Text>
      </>
    );
  }
  if (load.status === "error") {
    return (
      <>
        <ScreenTabs tab={tab} onChange={setTab} theme={theme} />
        <SettingsSection title="Agent Model Policy" testID="agent-model-policy-error">
          <Text style={{ color: theme.colors.statusDanger }}>{load.error}</Text>
          <SettingsAction label="Reload" actionLabel="Try again" onPress={load.reload} />
        </SettingsSection>
      </>
    );
  }

  const { model, state } = load;

  return (
    <>
      <ScreenTabs tab={tab} onChange={setTab} theme={theme} />
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
