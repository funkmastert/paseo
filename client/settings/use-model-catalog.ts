import { useCallback, useEffect, useState } from "react";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { roleModelPolicyRpc } from "../../shared/role-policy-rpc";

export interface ModelCatalogState {
  /** Installed/available provider family ids, for the "provider" side of the Add-model picker. */
  families: readonly string[];
  /** family -> model ids, populated lazily per family. */
  catalog: Readonly<Record<string, readonly string[]>>;
  loadingFamilies: ReadonlySet<string>;
  /** Fetches a family's models if not already cached. */
  ensureFamily(family: string): void;
  /** "Refresh Models": force-refetches every family currently referenced (already-loaded + the given ones), repopulating every Add-model dropdown. */
  refreshAll(extraFamilies?: readonly string[]): Promise<void>;
}

export function useModelCatalog(referencedFamilies: readonly string[]): ModelCatalogState {
  const paseo = usePaseo();
  const listModels = useRpc(roleModelPolicyRpc.listModels);
  const [families, setFamilies] = useState<readonly string[]>([]);
  const [catalog, setCatalog] = useState<Record<string, readonly string[]>>({});
  const [loadingFamilies, setLoadingFamilies] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    paseo.providers
      .listAvailable()
      .then((result) => {
        if (cancelled) return;
        setFamilies(result.providers.filter((p) => p.available).map((p) => p.provider));
      })
      .catch(() => {
        // Best-effort; the Add-model picker just has no family options until a retry.
      });
    return () => {
      cancelled = true;
    };
  }, [paseo]);

  const fetchFamilies = useCallback(
    async (targets: readonly string[], force: boolean) => {
      const unique = [...new Set(targets)].filter((f) => f.length > 0);
      if (unique.length === 0) return;
      setLoadingFamilies((current) => new Set([...current, ...unique]));
      try {
        const result = await listModels({ families: unique, force });
        setCatalog((current) => ({ ...current, ...result.catalog }));
      } finally {
        setLoadingFamilies((current) => {
          const next = new Set(current);
          for (const family of unique) next.delete(family);
          return next;
        });
      }
    },
    [listModels],
  );

  const ensureFamily = useCallback(
    (family: string) => {
      if (family in catalog || loadingFamilies.has(family)) return;
      void fetchFamilies([family], false);
    },
    [catalog, loadingFamilies, fetchFamilies],
  );

  const refreshAll = useCallback(
    async (extraFamilies: readonly string[] = []) => {
      const targets = new Set([...Object.keys(catalog), ...referencedFamilies, ...extraFamilies]);
      await fetchFamilies([...targets], true);
    },
    [catalog, referencedFamilies, fetchFamilies],
  );

  return { families, catalog, loadingFamilies, ensureFamily, refreshAll };
}
