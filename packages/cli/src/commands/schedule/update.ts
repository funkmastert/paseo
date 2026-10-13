import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import {
  createScheduleInspectRows,
  createScheduleInspectSchema,
  type ScheduleInspectRow,
} from "./schema.js";
import {
  connectScheduleClient,
  parseScheduleUpdateInput,
  requireNewAgentSchedule,
  toScheduleCommandError,
  type ScheduleCommandOptions,
} from "./shared.js";

export interface ScheduleUpdateOptions extends ScheduleCommandOptions {
  every?: string;
  cron?: string;
  timezone?: string;
  name?: string;
  prompt?: string;
  provider?: string;
  model?: string;
  mode?: string;
  cwd?: string;
  maxRuns?: string;
  noMaxRuns?: boolean;
  expiresIn?: string;
  noExpiresIn?: boolean;
}

export async function runUpdateCommand(
  id: string,
  options: ScheduleUpdateOptions,
  _command: Command,
): Promise<ListResult<ScheduleInspectRow>> {
  const input = parseScheduleUpdateInput({
    id,
    every: options.every,
    cron: options.cron,
    timezone: options.timezone,
    name: options.name,
    prompt: options.prompt,
    provider: options.provider,
    model: options.model,
    mode: options.mode,
    cwd: options.cwd,
    maxRuns: options.maxRuns,
    expiresIn: options.expiresIn,
    clearMaxRuns: options.noMaxRuns,
    clearExpires: options.noExpiresIn,
  });
  const { client } = await connectScheduleClient(options.host);
  try {
    await requireNewAgentSchedule(client, id);
    // Mirrors `schedule create`'s own PASEO_AGENT_ID -> callerAgentId forwarding: an agent
    // editing a schedule's new-agent config marks it agent-made for the Codex child guard, so a
    // later run can't dodge the guard by retargeting a human schedule to a codex-family provider.
    const callerAgentId = process.env.PASEO_AGENT_ID?.trim() || undefined;
    const payload = await client.scheduleUpdate({
      ...input,
      ...(callerAgentId ? { callerAgentId } : {}),
    });
    if (payload.error || !payload.schedule) {
      throw new Error(payload.error ?? `Failed to update schedule: ${id}`);
    }
    return {
      type: "list",
      data: createScheduleInspectRows(payload.schedule),
      schema: createScheduleInspectSchema(payload.schedule),
    };
  } catch (error) {
    throw toScheduleCommandError("SCHEDULE_UPDATE_FAILED", "update schedule", error);
  } finally {
    await client.close().catch(() => {});
  }
}
