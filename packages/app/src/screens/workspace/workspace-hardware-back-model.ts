/**
 * Hardware Back priority for the workspace screen. Two concerns compete for the same
 * `hardwareBackPress` event: dismissing the compact explorer overlay, and cross-workspace/tab
 * history navigation. RN's `BackHandler` dispatches listeners LIFO and stops at the first one
 * that returns `true` -- so registering them as two separate `useEffect`s makes "who wins" a
 * function of effect registration order, which silently inverts if either effect gets
 * reordered. This function makes the priority explicit and independent of registration order:
 * dismissing the overlay always wins over history navigation.
 */
export type WorkspaceHardwareBackAction = "dismissOverlay" | "historyBack" | "unhandled";

export function resolveWorkspaceHardwareBackAction(input: {
  isOverlayOpen: boolean;
  canGoBack: boolean;
}): WorkspaceHardwareBackAction {
  if (input.isOverlayOpen) {
    return "dismissOverlay";
  }
  if (input.canGoBack) {
    return "historyBack";
  }
  return "unhandled";
}
