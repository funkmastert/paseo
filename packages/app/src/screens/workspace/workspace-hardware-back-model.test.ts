import { describe, expect, it } from "vitest";
import { resolveWorkspaceHardwareBackAction } from "./workspace-hardware-back-model";

describe("resolveWorkspaceHardwareBackAction", () => {
  it("dismisses the overlay when it's open and there's nowhere to go back to", () => {
    expect(resolveWorkspaceHardwareBackAction({ isOverlayOpen: true, canGoBack: false })).toBe(
      "dismissOverlay",
    );
  });

  it("dismisses the overlay when it's open even though history could also go back -- dismiss wins, history is left untouched", () => {
    expect(resolveWorkspaceHardwareBackAction({ isOverlayOpen: true, canGoBack: true })).toBe(
      "dismissOverlay",
    );
  });

  it("goes back through history when the overlay is closed and history has somewhere to go", () => {
    expect(resolveWorkspaceHardwareBackAction({ isOverlayOpen: false, canGoBack: true })).toBe(
      "historyBack",
    );
  });

  it("leaves Back unhandled when the overlay is closed and there's no history to go back to", () => {
    expect(resolveWorkspaceHardwareBackAction({ isOverlayOpen: false, canGoBack: false })).toBe(
      "unhandled",
    );
  });
});
