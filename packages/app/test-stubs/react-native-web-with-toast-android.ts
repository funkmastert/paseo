// react-native-web has no Android-only ToastAndroid API, but toast-host.tsx imports it (guarded
// at runtime by Platform.OS === "android", which never happens here). Vite's browser tests use
// real ESM resolution and fail on the missing named export; re-export everything real plus a
// stub so the import itself doesn't break the bundle.
// @ts-expect-error react-native-web ships no type declarations for this deep entry point; the
// app otherwise only ever imports it through "react-native"'s own types.
export * from "react-native-web/dist/index.js";

export const ToastAndroid = {
  SHORT: 0,
  LONG: 1,
  TOP: 0,
  BOTTOM: 1,
  CENTER: 2,
  show: () => {},
  showWithGravity: () => {},
  showWithGravityAndOffset: () => {},
};
