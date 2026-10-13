import { useMemo, type ReactNode } from "react";
import {
  SafeAreaInsetsContext,
  useSafeAreaInsets,
  type EdgeInsets,
} from "react-native-safe-area-context";
import { useHasAccountAlerts } from "./store";

interface ContentInsetsInput {
  insets: EdgeInsets;
  bannerVisible: boolean;
}

/**
 * While the banner shows, it reserves the top safe-area inset and the window-chrome clearance
 * itself, so the app below it is no longer against the notch or the traffic lights and must not
 * reserve that space a second time.
 */
export function contentInsets({ insets, bannerVisible }: ContentInsetsInput): EdgeInsets {
  return bannerVisible ? { ...insets, top: 0 } : insets;
}

/** Re-renders when the banner appears or goes, not when its entries change. */
export function BelowBannerInsets({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const bannerVisible = useHasAccountAlerts();
  const value = useMemo(() => contentInsets({ insets, bannerVisible }), [bannerVisible, insets]);
  return <SafeAreaInsetsContext.Provider value={value}>{children}</SafeAreaInsetsContext.Provider>;
}
