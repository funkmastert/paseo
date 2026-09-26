import { findCatalogId, modelIdentity } from "../../shared/model-identity";
import { modelRefFamily, splitModelRef } from "../../shared/role-policy-schema";

/**
 * How one pool entry stands against the provider's catalog, for the row that
 * shows it. The same check the server's selection makes (`findCatalogId`), so
 * the row cannot say "fine" about an entry ordered selection skips.
 *
 * - `unknown`: that family's catalog hasn't loaded, so nothing can be said.
 */
export type PoolEntryStatus =
  | { kind: "listed" }
  | { kind: "resolved"; id: string }
  | { kind: "unadvertised"; allowlisted: boolean }
  | { kind: "unknown" };

export function poolEntryStatus(
  modelRef: string,
  catalog: Readonly<Record<string, readonly string[]>>,
  allowUnlistedModels: readonly string[],
): PoolEntryStatus {
  const parsed = splitModelRef(modelRef);
  if (parsed === null) {
    return { kind: "unknown" };
  }
  const family = modelRefFamily(parsed);
  const listed = catalog[family];
  if (listed === undefined) {
    return { kind: "unknown" };
  }
  const id = findCatalogId(listed, parsed.model);
  if (id === parsed.model) {
    return { kind: "listed" };
  }
  if (id !== undefined) {
    return { kind: "resolved", id };
  }
  const allowlisted = allowUnlistedModels.some((entry) => {
    const other = splitModelRef(entry);
    return other !== null && modelRefFamily(other) === family && modelIdentity(other.model) === modelIdentity(parsed.model);
  });
  return { kind: "unadvertised", allowlisted };
}

/** The sentence a pool row adds under its label, or undefined when there is nothing to say. */
export function poolEntryWarning(status: PoolEntryStatus): string | undefined {
  switch (status.kind) {
    case "resolved":
      return `The provider's catalog lists this as ${status.id}; that is the id that runs.`;
    case "unadvertised":
      return status.allowlisted
        ? "UNVERIFIED: the provider's catalog does not list it. It runs only because allowUnlistedModels names it."
        : "NEVER RUNS: the provider's catalog does not list it and allowUnlistedModels does not name it, so selection skips this entry. Fix the id, or add it to allowUnlistedModels if the provider does accept it.";
    default:
      return undefined;
  }
}
