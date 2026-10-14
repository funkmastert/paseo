import { StyleSheet } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";

// Shared by the bottom scroll-to-bottom button and the top jump-to-start button so the two
// stay pixel-identical as the mirror pair they're meant to be.
export const scrollIndicatorStyles = StyleSheet.create((theme) => ({
  button: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
    ...theme.shadow.sm,
  },
  icon: {
    color: theme.colors.foreground,
  },
}));

export const primaryColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
