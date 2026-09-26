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
  /** Set when the catalog check says something about this entry (see ./pool-entry-status.ts). */
  warning?: string;
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

/**
 * Whether this ref lets the account router choose the account. A bare ref
 * does; a `provider/model` ref names a provider. The distinction is the whole
 * point of the ref grammar, and it is invisible from the ref text alone
 * unless the row says so.
 */
function bindingHint(modelRef: string): string {
  return modelRef.includes("/")
    ? "Pinned to this provider."
    : "Any pooled account — survives one account being capped.";
}

/** One entry in a role's ordered model list — most-preferred first. */
export function ModelRow({ modelRef, isFirst, isLast, disabled, theme, warning, onMoveUp, onMoveDown, onRemove }: ModelRowProps) {
  return (
    <SettingsRow label={modelRef} hint={warning ? `${bindingHint(modelRef)} ${warning}` : bindingHint(modelRef)} testID={`model-row-${modelRef}`}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <IconButton name="ChevronUp" disabled={disabled || isFirst} color={theme.colors.foreground} onPress={onMoveUp} />
        <IconButton name="ChevronDown" disabled={disabled || isLast} color={theme.colors.foreground} onPress={onMoveDown} />
        <IconButton name="X" disabled={disabled} color={theme.colors.statusDanger} onPress={onRemove} />
      </View>
    </SettingsRow>
  );
}
