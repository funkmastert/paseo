import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsInput, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { MappingRow } from "./mapping-row";
import type { RoleModelPolicyModel, RoleModelPolicyModelState } from "./role-model-policy-model";

export interface AgentRoleMappingsSectionProps {
  model: RoleModelPolicyModel;
  state: RoleModelPolicyModelState;
  recentAgentTypes: readonly string[];
  theme: PluginSurfaceProps["theme"];
}

/** Verbatim per plan §2.8 — the honest boundary between what this hook enforces and what it only records. */
const TIER_B_NOTE =
  "Mappings apply to agents Paseo creates. In-process subagent personas (like Claude Code Task-tool types) aren't visible to this routing hook yet — see the roadmap note below.";

export function AgentRoleMappingsSection({ model, state, recentAgentTypes, theme }: AgentRoleMappingsSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const [draftAgentType, setDraftAgentType] = useState("");
  const [draftRoleId, setDraftRoleId] = useState(state.policy.roles[0]?.id ?? "");

  const suggestions = useMemo(() => {
    const query = draftAgentType.trim().toLowerCase();
    const existing = new Set(Object.keys(state.policy.agentTypeMappings));
    return recentAgentTypes
      .filter((value) => !existing.has(value))
      .filter((value) => query.length === 0 || value.toLowerCase().includes(query))
      .slice(0, 8);
  }, [draftAgentType, recentAgentTypes, state.policy.agentTypeMappings]);

  const mappingEntries = Object.entries(state.policy.agentTypeMappings);
  const roleOptions = state.policy.roles.map((role) => ({ label: role.name, value: role.id }));

  return (
    <SettingsSection title="Agent-Type Mappings" testID="agent-role-mappings-section">
      <SettingsAction
        label="Agent-type mappings"
        actionLabel={expanded ? "Hide" : "Show"}
        onPress={() => setExpanded((current) => !current)}
        testID="agent-role-mappings-toggle"
      />
      {!expanded ? null : (
        <>
          <Text style={{ color: theme.colors.foregroundMuted }}>
            Explicit mappings take priority, then the role declared on the spawn, then task
            classification for other agents. Add exact runtime names for custom or packaged agents.
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted }}>{TIER_B_NOTE}</Text>

          {mappingEntries.map(([agentType, roleId]) => (
            <MappingRow
              key={agentType}
              agentType={agentType}
              roleId={roleId}
              roles={state.policy.roles}
              disabled={state.saving || state.malformed}
              onRetarget={(nextRoleId) => void model.addMapping(agentType, nextRoleId)}
              onRemove={() => void model.removeMapping(agentType)}
            />
          ))}

          <SettingsInput
            label="Agent-type / title"
            onChangeText={setDraftAgentType}
            disabled={state.saving || state.malformed}
            placeholder="e.g. ce-code-reviewer"
            testID="add-mapping-key-input"
          />
          {suggestions.length > 0 ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {suggestions.map((value) => (
                <Pressable key={value} onPress={() => setDraftAgentType(value)}>
                  <Text style={{ color: theme.colors.accent }}>{value}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <SettingsSelect
            label="Target role"
            value={draftRoleId}
            options={roleOptions}
            disabled={state.saving || state.malformed}
            onValueChange={setDraftRoleId}
            testID="add-mapping-role-select"
          />
          <SettingsAction
            label="Add mapping"
            actionLabel="Add"
            disabled={state.saving || state.malformed || draftAgentType.trim().length === 0 || !draftRoleId}
            error={!state.canAddMapping.allowed ? state.canAddMapping.reason : null}
            onPress={() => {
              void model.addMapping(draftAgentType, draftRoleId);
              setDraftAgentType("");
            }}
            testID="add-mapping-action"
          />
        </>
      )}
    </SettingsSection>
  );
}
