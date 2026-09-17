import { Text } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow } from "@getpaseo/plugin/client/ui";
import { LEADER_ROLE_ID } from "../../shared/role-policy-schema";
import { AddModelDropdown } from "./add-model-dropdown";
import { ModelRow } from "./model-row";
import { RoleCardMetadataEditor } from "./role-card-metadata-editor";
import type { RoleModelPolicyModel, RoleModelPolicyModelState } from "./role-model-policy-model";
import { ToolProfileRow } from "./tool-profile-row";
import type { ModelCatalogState } from "./use-model-catalog";

/**
 * The leader role is the one an operator can't discover by watching subagents
 * spawn, so the card says outright which agents it governs.
 */
const LEADER_HINT =
  "Governs root agents — the ones you, the CLI, or the app start. Their subagents resolve their own roles.";

export interface RoleCardProps {
  roleId: string;
  model: RoleModelPolicyModel;
  state: RoleModelPolicyModelState;
  catalog: ModelCatalogState;
  theme: PluginSurfaceProps["theme"];
}

export function RoleCard({ roleId, model, state, catalog, theme }: RoleCardProps) {
  const role = state.roleById(roleId);
  if (!role) return null;

  const isEditingThis = state.editingRoleId === roleId;
  const deleteStatus = state.canDeleteRole(roleId);
  const addModelStatus = state.canAddModel(roleId);
  const aliasesText = role.aliases.length > 0 ? role.aliases.join(", ") : "none";
  const isLeader = role.id === LEADER_ROLE_ID;

  return (
    <SettingsCard testID={`role-card-${roleId}`}>
      <SettingsRow
        label={role.standard ? `${role.name} (standard)` : role.name}
        hint={isLeader ? LEADER_HINT : `Aliases: ${aliasesText}`}
      >
        <SettingsAction
          label="Edit name/aliases"
          actionLabel={isEditingThis ? "Editing…" : "Edit"}
          disabled={isEditingThis || state.malformed}
          onPress={() => model.beginEditRole(roleId)}
        />
        {!role.standard ? (
          <SettingsAction
            label="Delete role"
            actionLabel="Delete"
            disabled={!deleteStatus.allowed || state.saving}
            error={!deleteStatus.allowed ? deleteStatus.reason : null}
            onPress={() => void model.deleteRole(roleId)}
            testID={`role-delete-${roleId}`}
          />
        ) : null}
      </SettingsRow>

      {isEditingThis ? <RoleCardMetadataEditor model={model} state={state} /> : null}

      <ToolProfileRow
        roleId={roleId}
        profile={role.toolProfile}
        disabled={state.saving || state.malformed}
        onChange={(profile) => void model.setToolProfile(roleId, profile)}
      />

      {role.models.length === 0 ? (
        <Text style={{ color: theme.colors.foregroundMuted }}>Unconfigured — requests routed to this role pass through untouched.</Text>
      ) : null}
      {role.models.map((modelRef, index) => (
        <ModelRow
          key={modelRef}
          modelRef={modelRef}
          isFirst={index === 0}
          isLast={index === role.models.length - 1}
          disabled={state.saving || state.malformed}
          theme={theme}
          onMoveUp={() => void model.moveModel(roleId, modelRef, "up")}
          onMoveDown={() => void model.moveModel(roleId, modelRef, "down")}
          onRemove={() => void model.removeModel(roleId, modelRef)}
        />
      ))}

      <AddModelDropdown
        roleId={roleId}
        families={catalog.families}
        catalog={catalog.catalog}
        ensureFamily={catalog.ensureFamily}
        disabled={!addModelStatus.allowed || state.saving || state.malformed}
        disabledReason={addModelStatus.reason}
        onAdd={(modelRef) => void model.addModel(roleId, modelRef)}
      />
    </SettingsCard>
  );
}
