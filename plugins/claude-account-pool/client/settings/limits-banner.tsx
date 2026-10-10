import { Text } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsSection } from "@getpaseo/plugin/client/ui";

export interface MalformedBannerProps {
  error?: string;
  onReload(): void;
  theme: PluginSurfaceProps["theme"];
}

/** Shown instead of being wiped: the editor stays locked and keeps rendering the last known-good policy underneath. */
export function MalformedBanner({ error, onReload, theme }: MalformedBannerProps) {
  return (
    <SettingsSection title="Stored Policy Is Malformed" testID="malformed-policy-banner">
      <Text style={{ color: theme.colors.statusDanger }}>
        The stored policy failed validation, so editing is locked. Showing the last known-good version below.
        {error ? ` (${error})` : ""}
      </Text>
      <SettingsAction label="Reload" actionLabel="Try again" onPress={onReload} testID="malformed-policy-reload" />
    </SettingsSection>
  );
}
