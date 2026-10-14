import type { ComponentProps } from "react";
import { Platform } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";

export interface ScrollIndicatorFade {
  fadeIn: ComponentProps<typeof Animated.View>["entering"];
  fadeOut: ComponentProps<typeof Animated.View>["exiting"];
}

// Keep entry/exit animations off on Android due to RN dispatchDraw crashes
// tracked in react-native-reanimated#8422.
export function resolveScrollIndicatorFade(): ScrollIndicatorFade {
  if (Platform.OS === "android") {
    return { fadeIn: undefined, fadeOut: undefined };
  }
  return { fadeIn: FadeIn.duration(200), fadeOut: FadeOut.duration(200) };
}
