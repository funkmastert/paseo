import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { isElectronRuntimeMac } from "@/desktop/host";
import {
  type DesktopSettings,
  type DesktopSettingsPatch,
  type KeepDisplayAwake,
} from "@/desktop/settings/desktop-settings";
import { settingsStyles } from "@/styles/settings";

// The desktop main process holds `caffeinate` on macOS only, so the card is
// hidden everywhere else.
export function KeepAwakeCard({
  settings,
  updateSettings,
}: {
  settings: DesktopSettings["power"];
  updateSettings: (updates: DesktopSettingsPatch) => Promise<void>;
}) {
  const { t } = useTranslation();

  const handleToggleKeepAwake = useCallback(() => {
    void updateSettings({ power: { keepAwake: !settings.keepAwake } }).catch(() => {
      // useDesktopSettings owns the user-visible IPC error.
    });
  }, [settings.keepAwake, updateSettings]);

  const handleDisplayChange = useCallback(
    (keepDisplayAwake: KeepDisplayAwake) => {
      void updateSettings({ power: { keepDisplayAwake } }).catch(() => {
        // useDesktopSettings owns the user-visible IPC error.
      });
    },
    [updateSettings],
  );

  const displayOptions = useMemo(
    () => [
      { value: "always" as const, label: t("desktop.daemon.keepDisplayAwake.always") },
      {
        value: "on-power-adapter" as const,
        label: t("desktop.daemon.keepDisplayAwake.onPowerAdapter"),
      },
      { value: "never" as const, label: t("desktop.daemon.keepDisplayAwake.never") },
    ],
    [t],
  );

  if (!isElectronRuntimeMac()) {
    return null;
  }

  return (
    <View style={[settingsStyles.card, styles.card]}>
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("desktop.daemon.keepAwake.title")}</Text>
          <Text style={settingsStyles.rowHint}>{t("desktop.daemon.keepAwake.hint")}</Text>
        </View>
        <Switch
          value={settings.keepAwake}
          onValueChange={handleToggleKeepAwake}
          accessibilityLabel={t("desktop.daemon.keepAwake.title")}
        />
      </View>
      {settings.keepAwake ? (
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("desktop.daemon.keepDisplayAwake.title")}
            </Text>
            <Text style={settingsStyles.rowHint}>{t("desktop.daemon.keepDisplayAwake.hint")}</Text>
          </View>
          <SegmentedControl
            options={displayOptions}
            value={settings.keepDisplayAwake}
            onValueChange={handleDisplayChange}
            size="sm"
            testID="desktop-keep-display-awake"
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    marginTop: theme.spacing[3],
  },
}));
