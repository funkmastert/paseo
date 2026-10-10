import type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageDetail,
  ProviderUsageListResponseMessage,
  ProviderUsageStatus,
  ProviderUsageTone,
  ProviderUsageWindow,
} from "@getpaseo/protocol/messages";

export type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageDetail,
  ProviderUsageStatus,
  ProviderUsageTone,
  ProviderUsageWindow,
};

export type ProviderUsageBalanceUnit = ProviderUsageBalance["unit"];
export type ProviderUsageListPayload = ProviderUsageListResponseMessage["payload"];

export type ProviderUsageView =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      payload: ProviderUsageListPayload;
      isRefreshing: boolean;
      /**
       * When this payload was read from the daemon, as epoch ms. Usage windows are polled, not
       * pushed, and the daemon serves them from a five-minute cache, so a consumer that presents
       * them as the current numbers has to be able to say how old they are.
       */
      fetchedAt: number;
    };
