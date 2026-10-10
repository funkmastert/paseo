import { Text } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { TASK_CLASS_IDS, type TaskClassId } from "../../shared/role-policy-schema";
import { THINKING_LEVEL_IDS, THINKING_LEVEL_LABELS, ULTRACODE_OPTION_ID } from "../../shared/thinking-levels";
import type { RoleModelPolicyModel, RoleModelPolicyModelState } from "./role-model-policy-model";

export interface ThinkingSectionProps {
  model: RoleModelPolicyModel;
  state: RoleModelPolicyModelState;
  theme: PluginSurfaceProps["theme"];
}

/** Sentinel value for the "no leader rule" (`leader: null`) choice. Parentheses keep it outside THINKING_OPTION_ID_RE, so no real level id can collide with it. */
const NO_LEADER_RULE_VALUE = "(none)";

/** The effort ladder this editor offers: every known level except "minimal" (not a Claude level). */
const LEVEL_IDS = THINKING_LEVEL_IDS.filter((id) => id !== "minimal");

/** Leader choices: the "no rule" sentinel first, then every offered level, including Ultra Code — a choice, never the default. */
const LEADER_OPTIONS = [
  { label: "No leader rule", value: NO_LEADER_RULE_VALUE },
  ...LEVEL_IDS.map((id) => ({ label: THINKING_LEVEL_LABELS[id], value: id as string })),
];

/** Task-class choices: every offered level except Ultra Code — no subagent can ever run it. */
const TASK_CLASS_OPTIONS = LEVEL_IDS.filter((id) => id !== ULTRACODE_OPTION_ID).map((id) => ({
  label: THINKING_LEVEL_LABELS[id],
  value: id as string,
}));

const TASK_CLASS_ROW_LABELS: Readonly<Record<TaskClassId, string>> = {
  mechanical: "Mechanical",
  standard: "Standard",
  hard: "Hard",
};

export function ThinkingSection({ model, state, theme }: ThinkingSectionProps) {
  const disabled = state.saving || state.malformed;
  const { thinking } = state.policy;

  return (
    <SettingsSection
      title="Thinking"
      info={
        <Text style={{ color: theme.colors.foregroundMuted }}>
          Leaders — root agents and the leader role — run at the leader level, Extra High by default, which outranks
          one the caller asked for. Nothing defaults to Ultra Code, and subagents never run it: they use the level
          they asked for, else their task class's. A level a model doesn&apos;t offer falls back to the nearest one it
          does.
        </Text>
      }
      testID="thinking-section"
    >
      <SettingsSelect
        label="Leaders"
        value={thinking.leader ?? NO_LEADER_RULE_VALUE}
        options={LEADER_OPTIONS}
        disabled={disabled}
        onValueChange={(value) => void model.setLeaderThinking(value === NO_LEADER_RULE_VALUE ? null : value)}
        testID="thinking-leader"
      />
      {TASK_CLASS_IDS.map((taskClass) => (
        <SettingsSelect
          key={taskClass}
          label={TASK_CLASS_ROW_LABELS[taskClass]}
          value={thinking.byTaskClass[taskClass]}
          options={TASK_CLASS_OPTIONS}
          disabled={disabled}
          onValueChange={(value) => void model.setTaskClassThinking(taskClass, value)}
          testID={`thinking-${taskClass}`}
        />
      ))}
    </SettingsSection>
  );
}
