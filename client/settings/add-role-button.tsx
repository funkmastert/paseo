import { useState } from "react";
import { SettingsAction, SettingsInput } from "@getpaseo/plugin/client/ui";
import type { LimitStatus } from "./role-model-policy-model";

export interface AddRoleButtonProps {
  canAddRole: LimitStatus;
  saving: boolean;
  malformed: boolean;
  onAdd(name: string): void;
}

/** A custom role starts with no aliases/models; only its name is chosen up front. */
export function AddRoleButton({ canAddRole, saving, malformed, onAdd }: AddRoleButtonProps) {
  const [name, setName] = useState("");
  const disabled = !canAddRole.allowed || saving || malformed;

  return (
    <>
      <SettingsInput
        label="New role name"
        onChangeText={setName}
        disabled={disabled}
        placeholder="e.g. summarizer"
        testID="add-role-name-input"
      />
      <SettingsAction
        label="Add a custom role"
        actionLabel="Add role"
        disabled={disabled || name.trim().length === 0}
        error={!canAddRole.allowed ? canAddRole.reason : null}
        onPress={() => {
          onAdd(name);
          setName("");
        }}
        testID="add-role-action"
      />
    </>
  );
}
