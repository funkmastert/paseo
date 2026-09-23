import { SettingsAction, SettingsInput } from "@getpaseo/plugin/client/ui";
import type { RoleModelPolicyModel, RoleModelPolicyModelState } from "./role-model-policy-model";

export interface RoleCardMetadataEditorProps {
  model: RoleModelPolicyModel;
  state: RoleModelPolicyModelState;
}

/** Comma-separated alias input. This hint is persistent — always visible, not just on error. */
const ALIAS_FORMAT_HINT = "Comma-separated, e.g. \"scout, researcher\". Letters and numbers only.";

/** Name/alias draft editor: Save commits via the model's `save()`, Cancel discards via `cancelDraft()`. */
export function RoleCardMetadataEditor({ model, state }: RoleCardMetadataEditorProps) {
  const role = state.editingRoleId ? state.roleById(state.editingRoleId) : undefined;
  if (!role) return null;

  return (
    <>
      {!role.standard ? (
        <SettingsInput
          label="Name"
          initialValue={state.nameDraft}
          onChangeText={(text) => model.renameRole(text)}
          disabled={state.saving}
          testID={`role-name-input-${role.id}`}
        />
      ) : null}
      <SettingsInput
        label="Aliases"
        hint={ALIAS_FORMAT_HINT}
        initialValue={state.aliasesDraft}
        onChangeText={(text) => model.setAliases(text)}
        disabled={state.saving}
        error={state.saveError}
        testID={`role-aliases-input-${role.id}`}
      />
      <SettingsAction
        label="Save changes"
        actionLabel={state.saving ? "Saving…" : "Save"}
        disabled={state.saving}
        onPress={() => void model.save()}
        testID={`role-save-${role.id}`}
      />
      <SettingsAction
        label="Discard changes"
        actionLabel="Cancel"
        disabled={state.saving}
        onPress={() => model.cancelDraft()}
        testID={`role-cancel-${role.id}`}
      />
    </>
  );
}
