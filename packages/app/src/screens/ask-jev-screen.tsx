import { useCallback, useMemo, useSyncExternalStore, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { Plus, X } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import {
  ASK_JEV_MAX_OPTIONS,
  resolveAskJevAvailability,
  type AskJevAnswerType,
  type AskJevAvailability,
  type AskJevFormModel,
  type AskJevFormState,
  type AskJevHost,
  type AskJevLevel,
  type AskJevOption,
  type AskJevScalePreset,
} from "@/ask-jev/ask-jev-form-model";
import {
  ASK_JEV_KEY_FILE,
  ASK_JEV_KEY_VARIABLE,
  askJevReasonCopy,
  formatUsd,
} from "@/ask-jev/ask-jev-result";
import { AskJevResultCard } from "@/ask-jev/ask-jev-result-view";
import { useAskJevHostStatus } from "@/ask-jev/use-ask-jev-host-status";
import { useApplyAskJevAvailability, useAskJevFormModel } from "@/ask-jev/use-ask-jev-form-model";

const ANSWER_TYPE_OPTIONS: SegmentedControlOption<AskJevAnswerType>[] = [
  { value: "noul", label: "Yes / No", testID: "ask-jev-type-noul" },
  { value: "choice", label: "Pick one", testID: "ask-jev-type-choice" },
  { value: "score", label: "Score", testID: "ask-jev-type-score" },
];

const SCALE_PRESET_OPTIONS: SegmentedControlOption<AskJevScalePreset>[] = [
  { value: "low-high", label: "Low–High", testID: "ask-jev-scale-low-high" },
  { value: "one-to-five", label: "1–5", testID: "ask-jev-scale-one-to-five" },
  { value: "custom", label: "Custom", testID: "ask-jev-scale-custom" },
];

const NO_AGENT = "";

export function AskJevScreen(): ReactElement {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <AskJevScreenContent />;
}

function AskJevScreenContent(): ReactElement {
  const hosts = useHosts();
  const activeWorkspace = useActiveWorkspaceSelection();
  const formHosts = useMemo<AskJevHost[]>(
    () => hosts.map((host) => ({ serverId: host.serverId, label: host.label })),
    [hosts],
  );
  const model = useAskJevFormModel({
    hosts: formHosts,
    defaults: { serverId: activeWorkspace?.serverId ?? null },
  });
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const serverId = state.selectedServerId;
  const hostStatus = useAskJevHostStatus(serverId, { enabled: true });
  const availability = useMemo(
    () =>
      resolveAskJevAvailability({
        hasHost: serverId !== null,
        connected: hostStatus.connected,
        supportsAsk: hostStatus.supportsAsk,
        status: hostStatus.status,
        statusFailed: hostStatus.statusFailed,
      }),
    [
      serverId,
      hostStatus.connected,
      hostStatus.supportsAsk,
      hostStatus.status,
      hostStatus.statusFailed,
    ],
  );
  useApplyAskJevAvailability(model, serverId, availability);
  const client = useHostRuntimeClient(serverId ?? "");

  const handleAsk = useCallback(() => {
    const submission = model.submit();
    if (!submission) return;
    if (!client) {
      model.fail(submission.token, new Error("The host is not connected"));
      return;
    }
    // Not awaited: the screen stays live while JEV thinks, and Cancel drops a late answer.
    void client.jevAsk(submission.request).then(
      (payload) => {
        model.settle(submission.token, payload);
        return undefined;
      },
      (error: unknown) => {
        model.fail(submission.token, error);
      },
    );
  }, [client, model]);

  return (
    <View style={styles.container}>
      <MenuHeader title="Ask JEV" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        testID="ask-jev-screen"
      >
        <View style={styles.column}>
          <AvailabilityNotice availability={state.availability} />
          <AskJevForm model={model} state={state} />
          <AskJevActions model={model} state={state} onAsk={handleAsk} />
          <AskJevRunResult state={state} />
        </View>
      </ScrollView>
    </View>
  );
}

function AvailabilityNotice({ availability }: { availability: AskJevAvailability }) {
  switch (availability.kind) {
    case "not-configured":
      return (
        <Alert
          variant="warning"
          title="JEV is not configured on this host"
          description={`Add ${ASK_JEV_KEY_VARIABLE}=<key> to ${ASK_JEV_KEY_FILE} on the host, readable only by you (chmod 600). The daemon reads it within a few seconds, no restart. Nothing is sent to JEV until then.`}
          testID="ask-jev-not-configured"
        />
      );
    case "update-host":
      return (
        <Alert
          variant="info"
          title="Update the host to ask JEV"
          description="This host's daemon is older than Ask JEV. Update it, then come back."
          testID="ask-jev-update-host"
        />
      );
    case "off": {
      const copy = askJevReasonCopy(availability.reason);
      return (
        <Alert
          variant={copy.tone}
          title={copy.title}
          description={copy.description}
          testID="ask-jev-off"
        />
      );
    }
    case "budget-spent":
      return (
        <Alert
          variant="warning"
          title="Today's Ask JEV budget is spent"
          description={`The host caps these questions at ${formatUsd(availability.capUsd)} a day. It resets at ${new Date(availability.resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`}
          testID="ask-jev-budget-spent"
        />
      );
    case "connecting":
      return <Alert title="Waiting for the host to connect" testID="ask-jev-connecting" />;
    case "no-host":
      return (
        <Alert title="No host" description="Add a host to ask JEV." testID="ask-jev-no-host" />
      );
    case "ready":
      return availability.fake ? (
        <Alert
          variant="info"
          title="Fake backend"
          description="This host runs PASEO_JEV_BACKEND=fake. Answers are simulated and nothing leaves the machine."
          testID="ask-jev-fake-backend"
        />
      ) : null;
    case "checking":
      return null;
  }
}

interface FormPartProps {
  model: AskJevFormModel;
  state: AskJevFormState;
  size: FieldControlSize;
}

function AskJevForm({ model, state }: { model: AskJevFormModel; state: AskJevFormState }) {
  const size: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  return (
    <View style={styles.form}>
      {state.hosts.length > 1 ? <HostField model={model} state={state} size={size} /> : null}
      <Field label="Context" error={state.errors.context} testID="ask-jev-context-field">
        <FormTextInput
          size={size}
          testID="ask-jev-context-input"
          accessibilityLabel="Context"
          initialValue={state.context}
          onChangeText={model.setContext}
          placeholder="Paste a log, a diff, a message"
          style={styles.contextInput}
          multiline
          numberOfLines={6}
          textAlignVertical="top"
        />
      </Field>
      <AgentField model={model} state={state} size={size} />
      <Field label="Question" error={state.errors.question} testID="ask-jev-question-field">
        <FormTextInput
          size={size}
          testID="ask-jev-question-input"
          accessibilityLabel="Question"
          initialValue={state.question}
          onChangeText={model.setQuestion}
          placeholder="Is this failure flaky?"
          style={styles.questionInput}
          multiline
          numberOfLines={2}
          textAlignVertical="top"
        />
      </Field>
      <Field label="Answer">
        <SegmentedControl
          size={size}
          value={state.answerType}
          onValueChange={model.setAnswerType}
          options={ANSWER_TYPE_OPTIONS}
          testID="ask-jev-answer-type"
        />
      </Field>
      <AnswerEditor model={model} state={state} size={size} />
    </View>
  );
}

function HostField({ model, state, size }: FormPartProps) {
  const options = useMemo<SelectFieldOption<string>[]>(
    () =>
      state.hosts.map((host) => ({
        id: host.serverId,
        value: host.serverId,
        label: host.label,
        testID: `ask-jev-host-${host.serverId}`,
      })),
    [state.hosts],
  );
  return (
    <SelectField
      label="Host"
      value={state.selectedServerId}
      selectedDisplay={state.hostDisplay}
      options={options}
      onChange={model.setHost}
      placeholder="Select host"
      emptyText="No hosts found"
      searchable={false}
      title="Host"
      size={size}
      triggerTestID="ask-jev-host-trigger"
    />
  );
}

function AgentField({ model, state, size }: FormPartProps) {
  const { agents } = useAggregatedAgents();
  const options = useMemo<SelectFieldOption<string>[]>(
    () => [
      { id: "none", value: NO_AGENT, label: "None" },
      ...agents
        .filter((agent) => agent.serverId === state.selectedServerId && !agent.archivedAt)
        .map((agent) => ({
          id: agent.id,
          value: agent.id,
          label: agent.title?.trim() || "Untitled agent",
          testID: `ask-jev-agent-${agent.id}`,
        })),
    ],
    [agents, state.selectedServerId],
  );
  const handleChange = useCallback(
    (value: string, display: SelectFieldDisplay) => {
      model.setAgent(value === NO_AGENT ? null : value, { label: display.label });
    },
    [model],
  );
  return (
    <SelectField
      label="Agent thread"
      value={state.agentId ?? NO_AGENT}
      selectedDisplay={state.agentDisplay ?? NONE_DISPLAY}
      options={options}
      onChange={handleChange}
      placeholder="None"
      emptyText="No agents on this host"
      searchable
      searchPlaceholder="Search agents..."
      title="Attach an agent's recent activity"
      size={size}
      triggerTestID="ask-jev-agent-trigger"
    />
  );
}

const NONE_DISPLAY: SelectFieldDisplay = { label: "None" };

function AnswerEditor(props: FormPartProps) {
  switch (props.state.answerType) {
    case "noul":
      return <YesNoEditor {...props} />;
    case "choice":
      return <OptionsEditor {...props} />;
    case "score":
      return <ScaleEditor {...props} />;
  }
}

function DescribeSwitch({ model, state, label }: FormPartProps & { label: string }) {
  return (
    <Field label={label}>
      <Switch
        value={state.describeOptions}
        onValueChange={model.setDescribeOptions}
        accessibilityLabel={label}
        testID="ask-jev-describe-switch"
      />
    </Field>
  );
}

function YesNoEditor(props: FormPartProps) {
  const { model, state, size } = props;
  return (
    <>
      <DescribeSwitch {...props} label="Describe yes and no" />
      {state.describeOptions ? (
        <>
          <Field label="Yes means">
            <FormTextInput
              size={size}
              testID="ask-jev-yes-means"
              accessibilityLabel="Yes means"
              initialValue={state.yesMeans}
              onChangeText={model.setYesMeans}
              placeholder="Optional"
            />
          </Field>
          <Field label="No means">
            <FormTextInput
              size={size}
              testID="ask-jev-no-means"
              accessibilityLabel="No means"
              initialValue={state.noMeans}
              onChangeText={model.setNoMeans}
              placeholder="Optional"
            />
          </Field>
        </>
      ) : null}
    </>
  );
}

function OptionsEditor(props: FormPartProps) {
  const { model, state } = props;
  return (
    <>
      <Field label="Options" error={state.errors.options} testID="ask-jev-options-field">
        <View style={styles.rows}>
          {state.options.map((option, index) => (
            <OptionRow
              key={option.id}
              {...props}
              option={option}
              index={index}
              canRemove={state.options.length > 2}
            />
          ))}
          <View style={styles.addRow}>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={Plus}
              onPress={model.addOption}
              disabled={!state.canAddOption}
              accessibilityLabel={`Add option, up to ${ASK_JEV_MAX_OPTIONS}`}
              testID="ask-jev-add-option"
            >
              Add option
            </Button>
          </View>
        </View>
      </Field>
      <DescribeSwitch {...props} label="Describe each option" />
    </>
  );
}

function OptionRow({
  model,
  state,
  size,
  option,
  index,
  canRemove,
}: FormPartProps & { option: AskJevOption; index: number; canRemove: boolean }) {
  const handleLabel = useCallback(
    (value: string) => model.setOptionLabel(option.id, value),
    [model, option.id],
  );
  const handleDescription = useCallback(
    (value: string) => model.setOptionDescription(option.id, value),
    [model, option.id],
  );
  const handleRemove = useCallback(() => model.removeOption(option.id), [model, option.id]);
  return (
    <View style={styles.rowBlock}>
      <View style={styles.inputRow}>
        <View style={styles.inputGrow}>
          <FormTextInput
            size={size}
            testID={`ask-jev-option-${index}`}
            accessibilityLabel={`Option ${index + 1}`}
            initialValue={option.label}
            onChangeText={handleLabel}
            placeholder={`Option ${index + 1}`}
          />
        </View>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={X}
          onPress={handleRemove}
          disabled={!canRemove}
          accessibilityLabel={`Remove option ${index + 1}`}
          testID={`ask-jev-remove-option-${index}`}
        />
      </View>
      {state.describeOptions ? (
        <FormTextInput
          size={size}
          testID={`ask-jev-option-description-${index}`}
          accessibilityLabel={`When option ${index + 1} applies`}
          initialValue={option.description}
          onChangeText={handleDescription}
          placeholder="When it applies (optional)"
        />
      ) : null}
    </View>
  );
}

function ScaleEditor(props: FormPartProps) {
  const { model, state, size } = props;
  return (
    <Field label="Scale, lowest first" error={state.errors.levels} testID="ask-jev-scale-field">
      <View style={styles.rows}>
        <SegmentedControl
          size={size}
          value={state.scalePreset}
          onValueChange={model.setScalePreset}
          options={SCALE_PRESET_OPTIONS}
          testID="ask-jev-scale-preset"
        />
        {state.levels.map((level, index) => (
          <LevelRow
            key={level.id}
            {...props}
            level={level}
            index={index}
            canRemove={state.levels.length > 2}
          />
        ))}
        <View style={styles.addRow}>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={Plus}
            onPress={model.addLevel}
            disabled={!state.canAddLevel}
            testID="ask-jev-add-level"
          >
            Add level
          </Button>
        </View>
      </View>
    </Field>
  );
}

function LevelRow({
  model,
  size,
  level,
  index,
  canRemove,
}: FormPartProps & { level: AskJevLevel; index: number; canRemove: boolean }) {
  const handleLabel = useCallback(
    (value: string) => model.setLevelLabel(level.id, value),
    [model, level.id],
  );
  const handleRemove = useCallback(() => model.removeLevel(level.id), [model, level.id]);
  return (
    <View style={styles.inputRow}>
      <View style={styles.inputGrow}>
        <FormTextInput
          size={size}
          testID={`ask-jev-level-${index}`}
          accessibilityLabel={`Level ${index + 1}`}
          initialValue={level.label}
          onChangeText={handleLabel}
          placeholder={`Level ${index + 1}`}
        />
      </View>
      <Button
        variant="ghost"
        size="sm"
        leftIcon={X}
        onPress={handleRemove}
        disabled={!canRemove}
        accessibilityLabel={`Remove level ${index + 1}`}
        testID={`ask-jev-remove-level-${index}`}
      />
    </View>
  );
}

function AskJevActions({
  model,
  state,
  onAsk,
}: {
  model: AskJevFormModel;
  state: AskJevFormState;
  onAsk: () => void;
}) {
  const pending = state.run.status === "pending";
  return (
    <View style={styles.actions}>
      <Button
        variant="default"
        onPress={onAsk}
        disabled={!state.canSubmit}
        loading={pending}
        testID="ask-jev-submit"
      >
        {pending ? "Asking..." : "Ask"}
      </Button>
      {pending ? (
        <Button variant="outline" onPress={model.cancel} testID="ask-jev-cancel">
          Cancel
        </Button>
      ) : null}
    </View>
  );
}

function AskJevRunResult({ state }: { state: AskJevFormState }) {
  if (state.run.status === "settled") return <AskJevResultCard result={state.run.result} />;
  if (state.run.status === "cancelled") {
    return (
      <Text style={styles.muted} testID="ask-jev-cancelled">
        Cancelled. If the host already sent the question, it still finishes and is charged.
      </Text>
    );
  }
  return null;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[12],
  },
  column: {
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
    gap: theme.spacing[6],
  },
  form: {
    gap: theme.spacing[4],
  },
  contextInput: {
    minHeight: 120,
  },
  questionInput: {
    minHeight: 56,
  },
  rows: {
    gap: theme.spacing[2],
  },
  rowBlock: {
    gap: theme.spacing[2],
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  inputGrow: {
    flex: 1,
    minWidth: 0,
  },
  addRow: {
    flexDirection: "row",
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
