export const prPaneTimelineQueryKind = "prPaneTimeline";

export function prPaneTimelineQueryKey({
  serverId,
  cwd,
  prNumber,
}: {
  serverId: string;
  cwd: string;
  prNumber: number | null;
}) {
  return [prPaneTimelineQueryKind, serverId, cwd, prNumber] as const;
}

export const prPaneStatusByIdentityQueryKind = "prPaneStatusByIdentity";

export function prPaneStatusByIdentityQueryKey({
  serverId,
  host,
  repoOwner,
  repoName,
  number,
}: {
  serverId: string;
  host: string;
  repoOwner: string;
  repoName: string;
  number: number;
}) {
  return [prPaneStatusByIdentityQueryKind, serverId, host, repoOwner, repoName, number] as const;
}

export const prPanePipelineQueryKind = "prPanePipeline";

export function prPanePipelineQueryKey({
  serverId,
  cwd,
  pipelineId,
  changeRequestNumber,
}: {
  serverId: string;
  cwd: string;
  pipelineId: number | null;
  /** MR iid the pipeline is fetched by; part of the key since the fetch routes by it. */
  changeRequestNumber: number;
}) {
  return [prPanePipelineQueryKind, serverId, cwd, pipelineId, changeRequestNumber] as const;
}
