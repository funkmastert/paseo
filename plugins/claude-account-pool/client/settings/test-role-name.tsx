import { useState } from "react";
import { Text } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsInput, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { roleModelPolicyRpc, type RoleModelPolicyExplainResult } from "../../shared/role-policy-rpc";
import { TASK_CLASS_IDS, type TaskClassId } from "../../shared/role-policy-schema";
import { explainSummaryLines } from "./explain-summary";

/** "" is the wire-absent case: no `paseo.task-class` label on the create at all. */
type TaskClassChoice = "" | TaskClassId;

const TASK_CLASS_OPTIONS: ReadonlyArray<{ label: string; value: TaskClassChoice }> = [
  { label: "not declared", value: "" },
  ...TASK_CLASS_IDS.map((id) => ({ label: id, value: id as TaskClassChoice })),
];

const TASK_CLASS_HINT =
  "Simulates the paseo.task-class label a caller sets. Left undeclared, the prompt/title text is all the classifier has.";

/** A root agent has no calling agent, which is what makes it the leader — see the leader role's card. */
type StartedBy = "agent" | "root";

const STARTED_BY_OPTIONS: ReadonlyArray<{ label: string; value: StartedBy }> = [
  { label: "another agent (a subagent)", value: "agent" },
  { label: "you, the CLI, or the app (a root agent)", value: "root" },
];

/**
 * Lightweight diagnostic in place of PiSesh's `/worker-models`: runs the real
 * classifier over a hypothetical create without making an agent. Every line it
 * prints comes from the same `classifyAgent` call the create hook makes, so
 * "what the preview says" and "what actually happens" are one answer.
 */
export function TestRoleName({ theme }: { theme: PluginSurfaceProps["theme"] }) {
  const explain = useRpc(roleModelPolicyRpc.explain);
  const [agentType, setAgentType] = useState("");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [taskClass, setTaskClass] = useState<TaskClassChoice>("");
  const [startedBy, setStartedBy] = useState<StartedBy>("agent");
  const [requestedModel, setRequestedModel] = useState("");
  const [requestedProvider, setRequestedProvider] = useState("");
  const [requestedThinking, setRequestedThinking] = useState("");
  const [result, setResult] = useState<RoleModelPolicyExplainResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <SettingsSection title="Test This Name" testID="test-role-name-section">
      <SettingsInput label="Agent-type / title" onChangeText={setAgentType} placeholder="e.g. ce-code-reviewer" testID="test-role-name-agent-type" />
      <SettingsInput label="Title text (optional)" onChangeText={setTitle} placeholder="used for automatic classification" testID="test-role-name-title" />
      <SettingsInput
        label="Initial prompt (optional)"
        hint="The create hook classifies over the title AND the prompt. Leave this out and you are previewing a different question than the one the hook answers."
        onChangeText={setPrompt}
        placeholder="what the agent would be asked to do"
        testID="test-role-name-prompt"
      />
      <SettingsSelect<StartedBy>
        label="Started by"
        hint="A root agent resolves to the leader role structurally — no classification at all."
        value={startedBy}
        options={STARTED_BY_OPTIONS}
        onValueChange={setStartedBy}
        testID="test-role-name-started-by"
      />
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
      <SettingsInput
        label="Account (optional)"
        hint="What the create would put in config.provider. A root agent keeps it unless it is out of budget."
        onChangeText={setRequestedProvider}
        placeholder="e.g. claude-backup"
        testID="test-role-name-requested-provider"
      />
      <SettingsInput
        label="Explicit thinking request (optional)"
        hint="What the caller would put in its thinking option. Shows whether policy keeps it: a subagent never runs Ultra Code."
        onChangeText={setRequestedThinking}
        placeholder="e.g. ultracode"
        testID="test-role-name-requested-thinking"
      />
      <SettingsAction
        label="Resolution preview"
        actionLabel="Test"
        onPress={() => {
          setError(null);
          explain({
            agentType: agentType.trim().length > 0 ? agentType.trim() : undefined,
            title: title.trim().length > 0 ? title.trim() : undefined,
            prompt: prompt.trim().length > 0 ? prompt.trim() : undefined,
            taskClass: taskClass.length > 0 ? taskClass : undefined,
            root: startedBy === "root" ? true : undefined,
            requestedModel: requestedModel.trim().length > 0 ? requestedModel.trim() : undefined,
            requestedProvider: requestedProvider.trim().length > 0 ? requestedProvider.trim() : undefined,
            requestedThinkingOptionId: requestedThinking.trim().length > 0 ? requestedThinking.trim() : undefined,
          })
            .then(setResult)
            .catch((err) => setError(err instanceof Error ? err.message : String(err)));
        }}
        testID="test-role-name-action"
      />
      {result
        ? explainSummaryLines(result).map((line) => (
            <Text key={line} style={{ color: theme.colors.foreground }}>
              {line}
            </Text>
          ))
        : null}
      {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
    </SettingsSection>
  );
}
