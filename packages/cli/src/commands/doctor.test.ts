import { describe, expect, it } from "vitest";
import { renderDoctorHuman, type DoctorReport } from "./doctor.js";

const report = (
  findings: DoctorReport["findings"],
  extra: Partial<DoctorReport> = {},
): DoctorReport => ({
  source: "daemon",
  generatedAt: "2026-09-23T00:00:00.000Z",
  daemonVersion: "0.8.0",
  summary: {
    fail: findings.filter((f) => f.status === "fail").length,
    warn: findings.filter((f) => f.status === "warn").length,
    skip: findings.filter((f) => f.status === "skip").length,
    ok: findings.filter((f) => f.status === "ok").length,
  },
  findings,
  ...extra,
});

const problem = {
  id: "account.claude-md",
  category: "accounts",
  status: "fail" as const,
  title: "~/.claude-leader: no CLAUDE.md",
  detail: "the file does not exist",
  why: "sessions run without your rules",
  fix: "ln -s ~/.claude/CLAUDE.md ~/.claude-leader/CLAUDE.md",
};
const fine = {
  id: "disk.free",
  category: "disk",
  status: "ok" as const,
  title: "Disk: 100 GB free",
};

describe("renderDoctorHuman", () => {
  it("leads with the count, shows what/why/fix for problems, collapses passing checks, and ends with a next step", () => {
    const out = renderDoctorHuman(report([problem, fine]), { noColor: true });
    expect(out.split("\n")[0]).toBe("paseo doctor: 1 problem (ran in the daemon, daemon 0.8.0)");
    expect(out).toContain("✗ accounts  ~/.claude-leader: no CLAUDE.md");
    expect(out).toContain("    why: sessions run without your rules");
    expect(out).toContain("    fix: ln -s ~/.claude/CLAUDE.md ~/.claude-leader/CLAUDE.md");
    expect(out).not.toContain("Disk: 100 GB free");
    expect(out).toContain("1 check passed (--full lists them)");
    expect(out).toMatch(/Doctor changed nothing\. Run the fix commands above/);
  });

  it("lists passing checks with --full and says so when nothing needs attention", () => {
    const out = renderDoctorHuman(report([fine]), { noColor: true, full: true });
    expect(out).toContain("paseo doctor: Nothing needs attention");
    expect(out).toContain("✓ disk  Disk: 100 GB free");
    expect(out).toContain("Doctor changed nothing. Nothing to do.");
  });

  it("states where the checks ran when the daemon could not run them", () => {
    const out = renderDoctorHuman(
      report([fine], {
        source: "cli",
        daemonVersion: null,
        note: "The running daemon predates `paseo doctor`.",
      }),
      { noColor: true },
    );
    expect(out).toContain("(ran in the CLI)");
    expect(out).toContain("The running daemon predates `paseo doctor`.");
  });
});
