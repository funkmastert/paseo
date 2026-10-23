import { useEffect, useState } from "react";
import {
  openAskJevForm,
  type AskJevAvailability,
  type AskJevFormModel,
  type AskJevFormSnapshot,
} from "./ask-jev-form-model";

/**
 * One model per mount (docs/forms.md, lifecycle rule 2). Hosts and the selected host's
 * availability are late inputs piped in, never a reason to rebuild the model.
 */
export function useAskJevFormModel(snapshot: AskJevFormSnapshot): AskJevFormModel {
  const [model] = useState(() => openAskJevForm(snapshot));

  useEffect(() => {
    return () => {
      model.close();
    };
  }, [model]);

  useEffect(() => {
    model.applyHosts(snapshot.hosts);
  }, [model, snapshot.hosts]);

  return model;
}

export function useApplyAskJevAvailability(
  model: AskJevFormModel,
  serverId: string | null,
  availability: AskJevAvailability,
): void {
  useEffect(() => {
    if (serverId) model.applyAvailability(serverId, availability);
  }, [model, serverId, availability]);
}
