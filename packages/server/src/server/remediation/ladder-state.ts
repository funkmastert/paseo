import { promises as fs } from "node:fs";
import type { Logger } from "pino";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";

/**
 * `$PASEO_HOME/remediation/state.json`: what the ladder must not forget across a restart. An
 * in-flight agent is reconciled by id instead of re-spawned, and a cooldown or the daily count
 * survives, so a restart never buys a condition a second agent.
 */

const RemedyAttemptSchema = z.object({
  remedy: z.string(),
  outcome: z.enum(["acted", "nothing-to-do", "failed", "skipped"]),
  detail: z.string(),
  at: z.string(),
});

const ObservationSchema = z.object({
  key: z.string(),
  kind: z.string(),
  active: z.boolean(),
  remedy: z.enum(["live", "disabled", "dry-run", "none"]),
  title: z.string(),
  summary: z.string(),
  evidence: z.string().optional(),
  attempts: z.array(RemedyAttemptSchema).optional(),
  graceMs: z.number().optional(),
  level: z.enum(["notice", "alert", "urgent"]).optional(),
  escalation: z
    .object({
      task: z.string(),
      cwd: z.string().optional(),
      taskClass: z.enum(["mechanical", "standard", "hard"]).optional(),
    })
    .optional(),
  link: z.object({ agentId: z.string().optional(), workspaceId: z.string().optional() }).optional(),
});

const EpisodeSchema = z.object({
  key: z.string(),
  openedAt: z.string(),
  /** Set when an inactive observation closed it; the episode lingers only while its agent runs. */
  closedAt: z.string().optional(),
  /** Set when the episode opened inside the key's cooldown: rung 3 without a second agent. */
  openedInCooldown: z.boolean(),
  observation: ObservationSchema,
  agent: z.object({ id: z.string(), startedAt: z.string() }).optional(),
  /** The agent that ran, kept after it reported so rung 3 can link to it. */
  lastAgentId: z.string().optional(),
  /** Set by a FIXED report while the condition holds: one more grace window, then rung 3. */
  fixedGraceUntil: z.string().optional(),
  fixedLine: z.string().optional(),
  escalatedAt: z.string().optional(),
});

const LadderStateSchema = z.object({
  version: z.literal(1),
  episodes: z.array(EpisodeSchema),
  /** Per key, the ISO time before which the key may not start another agent. */
  cooldowns: z.record(z.string(), z.string()),
  daily: z.object({ day: z.string(), count: z.number() }),
});

export type LadderEpisode = z.infer<typeof EpisodeSchema>;
export type LadderState = z.infer<typeof LadderStateSchema>;

export function emptyLadderState(): LadderState {
  return { version: 1, episodes: [], cooldowns: {}, daily: { day: "", count: 0 } };
}

export async function loadLadderState(filePath: string, logger: Logger): Promise<LadderState> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn({ err: error, filePath }, "Remediation ladder: state unreadable; starting empty");
    }
    return emptyLadderState();
  }
  try {
    const parsed = LadderStateSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    logger.warn({ filePath, issues: parsed.error.issues }, "Remediation ladder: state invalid");
  } catch (error) {
    logger.warn({ err: error, filePath }, "Remediation ladder: state is not JSON");
  }
  return emptyLadderState();
}

export async function saveLadderState(filePath: string, state: LadderState): Promise<void> {
  await writeJsonFileAtomic(filePath, state);
}
