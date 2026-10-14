import type { Theme } from "@/styles/theme";
import type { CompletionState } from "@/utils/completion-state";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

export function getStatusDotColor(input: {
  theme: Theme;
  bucket: SidebarStateBucket;
  showDoneAsInactive?: boolean;
  completionState?: CompletionState | null;
}): string | null {
  const { theme, bucket, showDoneAsInactive = false, completionState = null } = input;

  // The one place the statusDot* band is read. Dots sit louder than the check icons and host
  // badges on the same row — see the band's note in theme.ts — so going through the status
  // family here instead would quietly put the row's state below its metadata.
  //
  // needs_input is amber because it wants something from you. Working is blue: an agent doing
  // its job is the one busy state that asks for nothing, so it should not sit in the same
  // color as the states that do.
  if (bucket === "needs_input") {
    return theme.colors.statusDotWarning;
  }
  if (bucket === "failed") {
    return theme.colors.statusDotDanger;
  }
  if (bucket === "running") {
    return theme.colors.statusDotRunning;
  }
  if (bucket === "attention") {
    return theme.colors.statusDotSuccess;
  }
  if (bucket === "done") {
    // A completion label refines "done" only once the row is quiescent (see
    // resolveRowCompletionIndicator) — same accent/success pairing the sidebar row's icon uses,
    // so the compact strip's dot and the full row never disagree on color.
    if (completionState === "ready-to-merge") {
      return theme.colors.accent;
    }
    if (completionState === "done") {
      return theme.colors.statusSuccess;
    }
    return showDoneAsInactive ? theme.colors.border : null;
  }
  return null;
}
