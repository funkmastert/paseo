const SNAPSHOT_DATE = /-\d{8}(?=\[|$)/;

/**
 * Whether two model ids name the same model. Case-folded, and a dated
 * snapshot matches its undated alias: a policy that names
 * `claude-haiku-4-5-20251001` and a catalog that lists `claude-haiku-4-5` are
 * naming the same model; comparing the strings made the pool entry look
 * unadvertised, so it was skipped and nothing said why. Two different dates
 * never match: `claude-3-5-sonnet-20240620` and `claude-3-5-sonnet-20241022`
 * are different snapshots, and approving one must not approve the other.
 * Only the date is folded. `claude-opus-5-5` and `claude-opus-5` stay
 * different models, and a `[1m]` context suffix stays part of the identity,
 * since it changes what runs.
 *
 * Shared because the server's selection and the settings screen's pool rows
 * must agree on what counts as listed.
 */
export function sameModel(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (left === right) {
    return true;
  }
  const leftDated = SNAPSHOT_DATE.test(left);
  const rightDated = SNAPSHOT_DATE.test(right);
  if (leftDated === rightDated) {
    return false;
  }
  return left.replace(SNAPSHOT_DATE, "") === right.replace(SNAPSHOT_DATE, "");
}

/**
 * The id a catalog lists for this model, whichever spelling asked: the exact
 * id when listed, else the listed id `sameModel` matches. That is the id
 * that runs, because it is the one the provider confirmed.
 */
export function findCatalogId(listed: Iterable<string>, model: string): string | undefined {
  const ids = [...listed];
  if (ids.includes(model)) {
    return model;
  }
  return ids.find((id) => sameModel(id, model));
}
