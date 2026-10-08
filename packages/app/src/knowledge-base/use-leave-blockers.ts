import { useEffect } from "react";
import { BackHandler } from "react-native";
import { useNavigation } from "expo-router";

/**
 * Routes the system's own back paths through the screen's guarded back while a draft is dirty:
 * Android's back button calls `onBack`, and iOS's edge swipe is switched off until the draft
 * is saved or discarded. Neither applies on web, where both calls are inert.
 */
export function useKnowledgeLeaveBlockers(input: { isDirty: boolean; onBack: () => void }): void {
  const { isDirty, onBack } = input;
  const navigation = useNavigation();

  useEffect(() => {
    if (!isDirty) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onBack();
      return true;
    });
    return () => subscription.remove();
  }, [isDirty, onBack]);

  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !isDirty });
  }, [isDirty, navigation]);
}
