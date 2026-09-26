/**
 * Writes a Claude Code output style into a create request's
 * `providerOptions.settings`, the same channel the tool deny tier uses
 * (`applyToolProfile`), so the two merge instead of one replacing the other.
 * The daemon passes `settings` to the CLI as `--settings`.
 *
 * Returns the options it was given, unchanged, when there is nothing to write.
 */
export function applyOutputStyle(providerOptions: unknown, style: string | null): Record<string, unknown> | undefined {
  const current =
    typeof providerOptions === "object" && providerOptions !== null ? (providerOptions as Record<string, unknown>) : undefined;
  if (style === null) {
    return current;
  }
  const currentSettings =
    typeof current?.settings === "object" && current.settings !== null ? (current.settings as Record<string, unknown>) : {};
  if (currentSettings.outputStyle === style) {
    return current;
  }
  return { ...current, settings: { ...currentSettings, outputStyle: style } };
}
