import { Pressable, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { SettingsRow } from "@getpaseo/plugin/client/ui";

export interface ModelRowProps {
  modelRef: string;
  isFirst: boolean;
  isLast: boolean;
  disabled: boolean;
  theme: PluginSurfaceProps["theme"];
  onMoveUp(): void;
  onMoveDown(): void;
  onRemove(): void;
}

function IconButton({
  name,
  disabled,
  color,
  onPress,
}: {
  name: string;
  disabled: boolean;
  color: string;
  onPress(): void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      style={{ paddingHorizontal: 6, opacity: disabled ? 0.35 : 1 }}
    >
      <Icon name={name} size={16} color={color} />
    </Pressable>
  );
}

/** One entry in a role's ordered model list — most-preferred first. */
export function ModelRow({ modelRef, isFirst, isLast, disabled, theme, onMoveUp, onMoveDown, onRemove }: ModelRowProps) {
  return (
    <SettingsRow label={modelRef} testID={`model-row-${modelRef}`}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <IconButton name="ChevronUp" disabled={disabled || isFirst} color={theme.colors.foreground} onPress={onMoveUp} />
        <IconButton name="ChevronDown" disabled={disabled || isLast} color={theme.colors.foreground} onPress={onMoveDown} />
        <IconButton name="X" disabled={disabled} color={theme.colors.statusDanger} onPress={onRemove} />
      </View>
    </SettingsRow>
  );
}
