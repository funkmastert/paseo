import { SettingsAction, SettingsSelect } from "@getpaseo/plugin/client/ui";
import type { RoleRecord } from "../../shared/role-policy-schema";

export interface MappingRowProps {
  agentType: string;
  roleId: string;
  roles: readonly RoleRecord[];
  disabled: boolean;
  onRetarget(roleId: string): void;
  onRemove(): void;
}

/** One `agentTypeMappings` entry: an exact caller-supplied agent-type/title string routed to a role. */
export function MappingRow({ agentType, roleId, roles, disabled, onRetarget, onRemove }: MappingRowProps) {
  const options = roles.map((role) => ({ label: role.name, value: role.id }));

  return (
    <>
      <SettingsSelect
        label={agentType}
        value={roleId}
        options={options}
        disabled={disabled}
        onValueChange={onRetarget}
        testID={`mapping-row-${agentType}`}
      />
      <SettingsAction
        label={`Remove "${agentType}"`}
        actionLabel="Remove"
        disabled={disabled}
        onPress={onRemove}
        testID={`mapping-remove-${agentType}`}
      />
    </>
  );
}
