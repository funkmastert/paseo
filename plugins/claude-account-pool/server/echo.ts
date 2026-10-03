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

/**
 * A caller-supplied value as a reason or log line quotes it: capped, so a huge
 * value cannot make a huge line. The cut lands between characters, never
 * inside a surrogate pair: `JSON.stringify` keeps a lone surrogate as an
 * escape, and `jq` renders it as U+FFFD.
 */
export function echoed(value: string): string {
  if (value.length <= MAX_ECHOED_CHARS) {
    return value;
  }
  const last = value.charCodeAt(MAX_ECHOED_CHARS - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? MAX_ECHOED_CHARS - 1 : MAX_ECHOED_CHARS;
  return `${value.slice(0, end)}…`;
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
