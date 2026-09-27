/**
 * How the plugin quotes a string it did not choose — a label value, a model
 * id, a thinking level, an output style or a provider id taken from an
 * `agent.create` request. A caller can make any of them megabytes long, and a
 * reason or log line that quotes one whole is then as long, on every create
 * that carries it. Every such quote goes through here.
 */

/** Longest caller-supplied value a reason or log line quotes; past it the value is cut and ends in an ellipsis. */
const MAX_ECHOED_CHARS = 120;

/** Most caller-supplied values a list quotes; past it the rest are counted. */
const MAX_ECHOED_ITEMS = 10;

/** A caller-supplied value as a reason or log line quotes it: capped, so a huge value cannot make a huge line. */
export function echoed(value: string): string {
  return value.length > MAX_ECHOED_CHARS ? `${value.slice(0, MAX_ECHOED_CHARS)}…` : value;
}

/** Caller-supplied values as a reason or log line lists them: each quoted and capped, and past the first few, counted. */
export function echoedList(values: readonly string[]): string {
  const listed = values
    .slice(0, MAX_ECHOED_ITEMS)
    .map((value) => `"${echoed(value)}"`)
    .join(", ");
  const rest = values.length - MAX_ECHOED_ITEMS;
  return rest > 0 ? `${listed} and ${rest} more` : listed;
}
