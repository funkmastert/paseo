import { useEffect, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { roleModelPolicyRpc } from "../../shared/role-policy-rpc";

/** Feeds the mapping-name input's autocomplete list. Fetched once per mount; the list only grows slowly (new agent-type/title values), so no polling. */
export function useRecentAgentTypes(): readonly string[] {
  const recentAgentTypes = useRpc(roleModelPolicyRpc.recentAgentTypes);
  const [values, setValues] = useState<readonly string[]>([]);

  useEffect(() => {
    let cancelled = false;
    recentAgentTypes({})
      .then((result) => {
        if (!cancelled) setValues(result.values);
      })
      .catch(() => {
        // Best-effort autocomplete data; a failed fetch just leaves the list empty.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return values;
}
