import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { renderTokenAuditTable, type TokenAuditReport } from "../session/doctor/tokens/types.js";

/**
 * `$PASEO_HOME/token-audit/`: one `report-<time>.json` and `.md` per run, newest last by name.
 * The JSON is what the next run diffs against; the markdown is what a person opens.
 */

const RowSchema = z.object({
  item: z.enum(["memory", "tools", "model", "hooks", "subagents", "scheduled", "cache"]),
  key: z.string(),
  finding: z.string(),
  severity: z.enum(["RED", "AMBER", "GREEN", "UNKNOWN"]),
  evidence: z.string(),
  cost: z.string(),
  metrics: z.record(z.string(), z.number()).optional(),
});

const StoredReportSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  source: z.enum(["job", "cli"]),
  rows: z.array(RowSchema),
  /** The ladder episode this report opened, closed when the next report is written. */
  episodeKey: z.string().optional(),
  /** Why it escalated, or empty when it was recorded quietly. */
  reasons: z.array(z.string()).optional(),
});

export type StoredReport = z.infer<typeof StoredReportSchema>;

const NAME = /^report-(\d{8}T\d{6}Z)\.json$/;

export class TokenAuditReportStore {
  constructor(private readonly dir: string) {}

  /** `report-20260924T150000Z` for an ISO time. */
  static stem(generatedAt: string): string {
    return `report-${generatedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
  }

  markdownPath(report: Pick<TokenAuditReport, "generatedAt">): string {
    return path.join(this.dir, `${TokenAuditReportStore.stem(report.generatedAt)}.md`);
  }

  async save(report: StoredReport): Promise<{ jsonPath: string; markdownPath: string }> {
    await fs.mkdir(this.dir, { recursive: true });
    const stem = TokenAuditReportStore.stem(report.generatedAt);
    const jsonPath = path.join(this.dir, `${stem}.json`);
    const markdownPath = path.join(this.dir, `${stem}.md`);
    await writeJsonFileAtomic(jsonPath, report);
    await fs.writeFile(
      markdownPath,
      `# Token audit ${report.generatedAt}\n\n${report.reasons?.length ? `Escalated: ${report.reasons.join("; ")}\n\n` : ""}${renderTokenAuditTable(report.rows)}\n`,
    );
    return { jsonPath, markdownPath };
  }

  /** Newest first. A file that does not parse is skipped, never fatal: it is only history. */
  async list(): Promise<StoredReport[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const reports: StoredReport[] = [];
    for (const name of names
      .filter((n) => NAME.test(n))
      .toSorted()
      .toReversed()) {
      try {
        const parsed = StoredReportSchema.safeParse(
          JSON.parse(await fs.readFile(path.join(this.dir, name), "utf8")),
        );
        if (parsed.success) reports.push(parsed.data);
      } catch {
        // Unreadable history: skip.
      }
    }
    return reports;
  }

  async latest(): Promise<StoredReport | null> {
    return (await this.list())[0] ?? null;
  }

  /** Keeps the newest `keep` reports (both files of each). */
  async prune(keep: number): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return;
    }
    const stems = names
      .filter((n) => NAME.test(n))
      .map((n) => n.replace(/\.json$/, ""))
      .toSorted()
      .toReversed();
    for (const stem of stems.slice(Math.max(1, keep))) {
      await fs.rm(path.join(this.dir, `${stem}.json`), { force: true });
      await fs.rm(path.join(this.dir, `${stem}.md`), { force: true });
    }
  }
}
