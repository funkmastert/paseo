import { useEffect, useState } from "react";
import { SettingsAction, SettingsRow, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { POOL_FAMILY } from "../../shared/role-policy-schema";
import type { ModelCatalogState } from "./use-model-catalog";

export interface AddModelDropdownProps {
  roleId: string;
  families: readonly string[];
  catalog: ModelCatalogState["catalog"];
  ensureFamily: ModelCatalogState["ensureFamily"];
  disabled: boolean;
  disabledReason?: string;
  onAdd(modelRef: string): void;
}

/**
 * The ref an operator's picks should produce.
 *
 * For the pooled family this is the BARE model id, not `claude/model`: the
 * account router owns account selection for that family, so writing the
 * provider segment would only re-create the ambiguity that pinned every role
 * to one account. Other families keep `provider/model`, which is what
 * actually moves a request to a different provider.
 */
function composeModelRef(family: string, model: string): string {
  return family === POOL_FAMILY ? model : `${family}/${model}`;
}

/** Two-stage picker (provider family, then one of its models) feeding one ref into `onAdd`. */
export function AddModelDropdown({ roleId, families, catalog, ensureFamily, disabled, disabledReason, onAdd }: AddModelDropdownProps) {
  const [family, setFamily] = useState<string>(families[0] ?? "");
  const [model, setModel] = useState<string>("");

  useEffect(() => {
    if (family) ensureFamily(family);
  }, [family, ensureFamily]);

  useEffect(() => {
    // Reset the model choice whenever the family (or its catalog) changes so a stale selection can't be added.
    setModel("");
  }, [family, catalog[family]]);

  if (families.length === 0) {
    return <SettingsRow label="Add model" hint="No provider families available yet." testID={`add-model-${roleId}`} />;
  }

  const familyOptions = families.map((f) => ({ label: f, value: f }));
  const models = catalog[family] ?? [];
  const modelOptions = models.map((m) => ({ label: m, value: m }));

  return (
    <>
      <SettingsSelect
        label="Provider"
        value={family}
        options={familyOptions}
        disabled={disabled}
        onValueChange={setFamily}
        testID={`add-model-provider-${roleId}`}
      />
      <SettingsSelect
        label="Model"
        value={model}
        options={modelOptions.length > 0 ? modelOptions : [{ label: "(none loaded)", value: "" }]}
        disabled={disabled || modelOptions.length === 0}
        onValueChange={setModel}
        testID={`add-model-model-${roleId}`}
      />
      <SettingsAction
        label="Add to this role"
        hint={
          family === POOL_FAMILY
            ? "Added account-agnostic: the pool picks which account runs it."
            : `Added as ${family}/…, pinned to that provider.`
        }
        actionLabel="Add"
        disabled={disabled || !family || !model}
        error={disabled ? disabledReason : null}
        onPress={() => {
          onAdd(composeModelRef(family, model));
          setModel("");
        }}
        testID={`add-model-action-${roleId}`}
      />
    </>
  );
}
