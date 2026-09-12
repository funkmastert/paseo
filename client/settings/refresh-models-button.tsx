import { useState } from "react";
import { SettingsAction } from "@getpaseo/plugin/client/ui";
import type { ModelCatalogState } from "./use-model-catalog";

export interface RefreshModelsButtonProps {
  catalog: ModelCatalogState;
}

/** Force-refetches every family's model list and repopulates every role's Add-model dropdown. */
export function RefreshModelsButton({ catalog }: RefreshModelsButtonProps) {
  const [refreshing, setRefreshing] = useState(false);

  return (
    <SettingsAction
      label="Model catalog"
      actionLabel={refreshing ? "Refreshing…" : "Refresh Models"}
      disabled={refreshing}
      onPress={() => {
        setRefreshing(true);
        void catalog.refreshAll().finally(() => setRefreshing(false));
      }}
      testID="refresh-models-button"
    />
  );
}
