/**
 * The spelling-independent identity of a model id: case-folded, with a
 * trailing `-YYYYMMDD` snapshot date removed. A policy that names
 * `claude-haiku-4-5-20251001` and a catalog that lists `claude-haiku-4-5` are
 * naming the same model; comparing the strings made the pool entry look
 * unadvertised, so it was skipped and nothing said why. Only the date is
 * folded. `claude-opus-5-5` and `claude-opus-5` stay different models, and a
 * `[1m]` context suffix stays part of the identity, since it changes what runs.
 *
 * Shared because the server's selection and the settings screen's pool rows
 * must agree on what counts as listed.
 */
export function modelIdentity(model: string): string {
  return model.trim().toLowerCase().replace(/-\d{8}(?=\[|$)/, "");
}

/**
 * The id a catalog lists for this model, whichever spelling asked: the exact
 * id when listed, else the listed id with the same identity. That is the id
 * that runs, because it is the one the provider confirmed.
 */
export function findCatalogId(listed: Iterable<string>, model: string): string | undefined {
  const ids = [...listed];
  if (ids.includes(model)) {
    return model;
  }
  const identity = modelIdentity(model);
  return ids.find((id) => modelIdentity(id) === identity);
}
