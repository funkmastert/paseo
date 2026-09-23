import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { roleModelPolicyRpc } from "../../shared/role-policy-rpc";
import { openRoleModelPolicyModel, type RoleModelPolicyModel, type RoleModelPolicyModelState } from "./role-model-policy-model";

export type RoleModelPolicyLoadState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; model: RoleModelPolicyModel; state: RoleModelPolicyModelState };

/**
 * Adapter hook: owns the one effect this screen needs (the initial/`reload`
 * fetch) and constructs the pure model exactly once per successful load,
 * per docs/forms.md. Subsequent server truth (a later `reload()`, or the
 * result of a mutation the model already applied itself) flows into the
 * SAME model instance via `applyPolicySnapshot`, never a reconstruction —
 * reconstructing on every render would drop whatever draft the user has
 * open.
 */
export function useRoleModelPolicy(): RoleModelPolicyLoadState & { reload(): void } {
  const read = useRpc(roleModelPolicyRpc.read);
  const write = useRpc(roleModelPolicyRpc.write);
  const modelRef = useRef<RoleModelPolicyModel | null>(null);
  const [load, setLoad] = useState<{ status: "loading" } | { status: "error"; error: string } | { status: "ready" }>({
    status: "loading",
  });
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  const tokenRef = useRef(0);

  const reload = useCallback(() => {
    const token = (tokenRef.current += 1);
    setLoad((current) => (current.status === "ready" ? current : { status: "loading" }));
    read({})
      .then((result) => {
        if (tokenRef.current !== token) return;
        const snapshot = { policy: result.policy, malformed: result.malformed, malformedError: result.error };
        if (modelRef.current) {
          modelRef.current.applyPolicySnapshot(snapshot);
        } else {
          modelRef.current = openRoleModelPolicyModel(snapshot, { write });
        }
        setLoad({ status: "ready" });
      })
      .catch((error) => {
        if (tokenRef.current !== token) return;
        setLoad({ status: "error", error: error instanceof Error ? error.message : String(error) });
      });
  }, [read, write]);

  useEffect(() => {
    reload();
    // Intentionally runs once per mount; `reload` is also exposed for the
    // banner's explicit "Try again" action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const model = modelRef.current;
    if (!model) return;
    return model.subscribe(forceRender);
  }, [load.status]);

  if (load.status === "loading") return { status: "loading", reload };
  if (load.status === "error") return { status: "error", error: load.error, reload };
  // load.status === "ready" implies modelRef.current was just set (or already existed).
  const model = modelRef.current!;
  return { status: "ready", model, state: model.getState(), reload };
}
