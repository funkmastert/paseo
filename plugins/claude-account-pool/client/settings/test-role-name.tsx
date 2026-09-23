import { useState } from "react";
import { Text } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsInput, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { roleModelPolicyRpc, type RoleModelPolicyExplainResult } from "../../shared/role-policy-rpc";
import { TASK_CLASS_IDS, type TaskClassId } from "../../shared/role-policy-schema";
import { explainSummaryLines } from "./explain-summary";
import type { RoleModelPolicyModelState } from "./role-model-policy-model";

/** "" is the wire-absent case: no `paseo.task-class` label on the create at all. */
type TaskClassChoice = "" | TaskClassId;

const TASK_CLASS_OPTIONS: ReadonlyArray<{ label: string; value: TaskClassChoice }> = [
  { label: "not declared", value: "" },
  ...TASK_CLASS_IDS.map((id) => ({ label: id, value: id as TaskClassChoice })),
];

const TASK_CLASS_HINT =
  "Simulates the paseo.task-class label a caller sets. Left undeclared, the prompt/title text is all the classifier has.";

/** Lightweight diagnostic in place of PiSesh's `/worker-models` — simulates resolution for a hypothetical agent-type/title without creating an agent. */
export function TestRoleName({ theme, state }: { theme: PluginSurfaceProps["theme"]; state: RoleModelPolicyModelState }) {
  const explain = useRpc(roleModelPolicyRpc.explain);
  const [agentType, setAgentType] = useState("");
  const [title, setTitle] = useState("");
  const [taskClass, setTaskClass] = useState<TaskClassChoice>("");
  const [requestedModel, setRequestedModel] = useState("");
  const [result, setResult] = useState<RoleModelPolicyExplainResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <SettingsSection title="Test This Name" testID="test-role-name-section">
      <SettingsInput label="Agent-type / title" onChangeText={setAgentType} placeholder="e.g. ce-code-reviewer" testID="test-role-name-agent-type" />
      <SettingsInput label="Prompt/title text (optional)" onChangeText={setTitle} placeholder="used for automatic classification" testID="test-role-name-title" />
      <SettingsSelect<TaskClassChoice>
        label="Task class"
        hint={TASK_CLASS_HINT}
        value={taskClass}
        options={TASK_CLASS_OPTIONS}
        onValueChange={setTaskClass}
        testID="test-role-name-task-class"
      />
      <SettingsInput
        label="Explicit model request (optional)"
        hint="What the caller would put in config.model. Shows whether policy honors it or overrides it for this task class."
        onChangeText={setRequestedModel}
        placeholder="e.g. claude-opus-5"
        testID="test-role-name-requested-model"
      />
      <SettingsAction
        label="Resolution preview"
        actionLabel="Test"
        onPress={() => {
          setError(null);
          explain({
            agentType: agentType.trim().length > 0 ? agentType.trim() : undefined,
            title: title.trim().length > 0 ? title.trim() : undefined,
            taskClass: taskClass.length > 0 ? taskClass : undefined,
            requestedModel: requestedModel.trim().length > 0 ? requestedModel.trim() : undefined,
          })
            .then(setResult)
            .catch((err) => setError(err instanceof Error ? err.message : String(err)));
        }}
        testID="test-role-name-action"
      />
      {result
        ? explainSummaryLines(result, state.roleById(result.roleId)).map((line) => (
            <Text key={line} style={{ color: theme.colors.foreground }}>
              {line}
            </Text>
          ))
        : null}
      {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
    </SettingsSection>
  );
}
