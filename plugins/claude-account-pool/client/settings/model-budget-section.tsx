import { Text } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import type { RoleModelPolicyModel, RoleModelPolicyModelState } from "./role-model-policy-model";

export interface ModelBudgetSectionProps {
  model: RoleModelPolicyModel;
  state: RoleModelPolicyModelState;
  theme: PluginSurfaceProps["theme"];
}

/**
 * A select rather than a free-text percent: the plugin SDK's SettingsInput is
 * untyped text, so a numeric field would mean hand-rolling parse/validation
 * feedback for a value with no meaningful precision below ~5%.
 */
const THRESHOLD_CHOICES = [50, 60, 70, 75, 80, 85, 90, 95, 100];

export function ModelBudgetSection({ model, state, theme }: ModelBudgetSectionProps) {
  return (
    <SettingsSection
      title="Fable budget"
      info={
        <Text style={{ color: theme.colors.foregroundMuted }}>
          Fable is the expensive escalation model. Once every pooled account is at or above this share of its weekly
          Fable window, roles skip their Fable entry and fall to the next model in their own pool — so the cap lands at
          a model boundary instead of mid-task. Other model families aren&apos;t gated; their hard cap already evacuates
          them.
        </Text>
      }
      testID="model-budget-section"
    >
      <SettingsSelect
        label="Step off Fable at"
        hint="100% means only once the window is actually capped."
        value={String(state.policy.modelBudgetThresholdPct)}
        options={THRESHOLD_CHOICES.map((pct) => ({ label: `${pct}%`, value: String(pct) }))}
        disabled={state.saving || state.malformed}
        onValueChange={(value) => void model.setModelBudgetThreshold(Number(value))}
        testID="model-budget-threshold"
      />
    </SettingsSection>
  );
}
