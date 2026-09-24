import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { DoctorFinding } from "@getpaseo/protocol/doctor/rpc-schemas";
import { resolveAccountSlots, canonicalClaudeDir } from "./accounts.js";
import { finding, type DoctorCheck, type DoctorContext } from "./context.js";
import {
  joinCommands,
  linkCommand,
  lstatOrNull,
  moveAsideCommand,
  realpathOrNull,
} from "./helpers.js";

/**
 * What can be checked about skills without understanding them (OR-D12):
 *  - every account's `skills/` is the canonical `~/.claude/skills` or an exact copy of it;
 *  - the copies Paseo installs match the bundle this daemon ships;
 *  - each canonical skill is well formed and points only at paths that still exist.
 * Skills drifted from the code they describe twice in one week; a moved path or a stale copy is
 * the part of that a machine can see.
 */

const MAX_LISTED = 8;

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function walkFiles(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of listDirs(path.join(root, rel))) {
    const next = path.join(rel, name);
    let stat;
    try {
      stat = statSync(path.join(root, next));
    } catch {
      continue;
    }
    if (stat.isDirectory()) out.push(...walkFiles(root, next));
    else out.push(next);
  }
  return out;
}

function hashTree(root: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const rel of walkFiles(root)) {
    try {
      hashes.set(
        rel.split(path.sep).join("/"),
        createHash("sha256")
          .update(readFileSync(path.join(root, rel)))
          .digest("hex"),
      );
    } catch {
      // Unreadable file: leave it out; it shows as missing.
    }
  }
  return hashes;
}

function listed(items: string[]): string {
  const shown = items.slice(0, MAX_LISTED).join(", ");
  return items.length > MAX_LISTED ? `${shown}, …${items.length - MAX_LISTED} more` : shown;
}

function checkMirrors(ctx: DoctorContext): DoctorFinding[] {
  const canonicalSkills = path.join(canonicalClaudeDir(ctx), "skills");
  const canonicalReal = realpathOrNull(canonicalSkills);
  const out: DoctorFinding[] = [];
  const id = "skills.mirror";
  for (const slot of resolveAccountSlots(ctx)) {
    if (slot.isCanonical) continue;
    const dir = path.join(slot.configDir, "skills");
    const name = `${slot.configDir} (${slot.providers.map((p) => p.label).join(", ")})`;
    const stat = lstatOrNull(dir);
    const relink = joinCommands(
      [
        ...(stat ? [moveAsideCommand(dir, `${dir}.pre-symlink`, ctx.platform)] : []),
        linkCommand(canonicalSkills, dir, { directory: true, platform: ctx.platform }),
      ],
      ctx.platform,
    );
    const why =
      "Sessions on this account see a different skill set, so the same prompt behaves differently per account.";
    if (!canonicalReal) {
      out.push(
        finding(id, "skills", "skip", `${name}: no canonical skills dir at ${canonicalSkills}`),
      );
      continue;
    }
    if (!stat) {
      out.push(
        finding(id, "skills", "warn", `${name}: no skills/`, {
          detail: `${dir} does not exist.`,
          why,
          fix: relink,
        }),
      );
      continue;
    }
    const real = realpathOrNull(dir);
    if (real === canonicalReal) {
      out.push(finding(id, "skills", "ok", `${name}: skills/ is the canonical set`));
      continue;
    }
    if (stat.isSymbolicLink() || !real) {
      out.push(
        finding(id, "skills", "fail", `${name}: skills/ points somewhere else`, {
          detail: `${dir} resolves to ${real ?? "a missing target"}.`,
          why,
          fix: relink,
        }),
      );
      continue;
    }
    const canonical = hashTree(canonicalReal);
    const copy = hashTree(real);
    const missing = new Set<string>();
    const changed = new Set<string>();
    const top = (rel: string) => rel.split("/")[0]!;
    for (const [rel, hash] of canonical) {
      const other = copy.get(rel);
      if (other === undefined) missing.add(top(rel));
      else if (other !== hash) changed.add(top(rel));
    }
    const extra = new Set([...copy.keys()].filter((rel) => !canonical.has(rel)).map(top));
    if (missing.size + changed.size + extra.size === 0) {
      out.push(
        finding(id, "skills", "warn", `${name}: skills/ is an identical private copy`, {
          detail: "It matches now and drifts on the next edit to either side.",
          why,
          fix: relink,
        }),
      );
      continue;
    }
    out.push(
      finding(id, "skills", "fail", `${name}: skills/ has drifted from ~/.claude/skills`, {
        detail: [
          missing.size > 0 && `missing here: ${listed([...missing])}`,
          changed.size > 0 && `different content: ${listed([...changed])}`,
          extra.size > 0 && `only here: ${listed([...extra])}`,
        ]
          .filter(Boolean)
          .join("\n"),
        why,
        fix: `${relink}   # review ${dir}.pre-symlink first; anything only there is not carried over`,
      }),
    );
  }
  return out;
}

const PATH_REFERENCE = /`((?:~|\/Users\/[^/`\s]+|\/home\/[^/`\s]+)\/[A-Za-z0-9_@.+/-]+)`/g;
const NON_LITERAL = /[*<>{}$]|\.\.\./;

function parseFrontmatter(text: string): Record<string, string> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  const out: Record<string, string> = {};
  let key: string | null = null;
  for (const line of match[1]!.split(/\r?\n/)) {
    const top = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (top) {
      key = top[1]!;
      out[key] = top[2]!.replace(/^[>|][+-]?$/, "").trim();
    } else if (key && line.trim()) {
      out[key] = `${out[key] ?? ""} ${line.trim()}`.trim();
    }
  }
  return out;
}

/** Paths a skill names in backticks that point into a directory that is gone. */
function missingPathReferences(ctx: DoctorContext, text: string): string[] {
  const missing = new Set<string>();
  for (const match of text.matchAll(PATH_REFERENCE)) {
    const raw = match[1]!.replace(/[.,:;)]+$/, "");
    if (NON_LITERAL.test(raw) || raw.startsWith("/tmp")) continue;
    // A /home path is never meaningful off Linux, and a path in a directory that exists is
    // usually a file the tool writes at run time. A missing directory is a moved project.
    if (raw.startsWith("/home/") && ctx.platform !== "linux") continue;
    const resolved = raw.startsWith("~") ? path.join(ctx.home, raw.slice(1)) : raw;
    if (existsSync(resolved)) continue;
    if (existsSync(path.dirname(resolved.replace(/\/+$/, "")))) continue;
    missing.add(raw);
  }
  return [...missing];
}

/** Namespace directories (e.g. synced/) hold skills one level down. */
function holdsNestedSkills(dir: string): boolean {
  return listDirs(dir).some(
    (child) =>
      existsSync(path.join(dir, child, "SKILL.md")) ||
      existsSync(path.join(dir, child, "manifest.json")),
  );
}

/** Problems with one skill directory; `skill` is false when it is not a skill at all. */
function lintSkillDir(ctx: DoctorContext, root: string, name: string) {
  const dir = path.join(root, name);
  if (lstatOrNull(dir)?.isSymbolicLink() && !realpathOrNull(dir)) {
    return { skill: false, problems: [`${name}: symlink target is gone`] };
  }
  const skillFile = path.join(dir, "SKILL.md");
  if (!existsSync(skillFile)) {
    const bare = !holdsNestedSkills(dir) && statSync(dir).isDirectory();
    return { skill: false, problems: bare ? [`${name}: no SKILL.md`] : [] };
  }
  const text = readFileSync(skillFile, "utf8");
  const meta = parseFrontmatter(text);
  const problems: string[] = [];
  if (!meta?.["name"] || !meta["description"]) {
    problems.push(`${name}: SKILL.md frontmatter is missing name or description`);
  } else if (meta["name"] !== name) {
    problems.push(`${name}: frontmatter name is "${meta["name"]}"`);
  }
  const missing = missingPathReferences(ctx, text);
  if (missing.length > 0) {
    problems.push(`${name}: names path(s) that no longer exist — ${listed(missing)}`);
  }
  return { skill: true, problems };
}

function checkCanonicalSkills(ctx: DoctorContext): DoctorFinding[] {
  const root = path.join(canonicalClaudeDir(ctx), "skills");
  if (!existsSync(root)) return [];
  const problems: string[] = [];
  let count = 0;
  for (const name of listDirs(root)) {
    if (name.startsWith(".")) continue;
    const result = lintSkillDir(ctx, root, name);
    problems.push(...result.problems);
    if (result.skill) count += 1;
  }
  if (problems.length === 0) {
    return [
      finding(
        "skills.lint",
        "skills",
        "ok",
        `${count} skills are well formed and every path they name exists`,
      ),
    ];
  }
  return [
    finding(
      "skills.lint",
      "skills",
      "warn",
      `${problems.length} skill(s) reference things that are gone or are malformed`,
      {
        detail: problems.slice(0, 20).join("\n"),
        why: "A skill that names a moved path or a retired command sends the agent to look somewhere that is not there, and it does not say so.",
        fix: `Edit the named SKILL.md under ${root} (or delete the skill if it is retired).`,
      },
    ),
  ];
}

async function checkManaged(ctx: DoctorContext): Promise<DoctorFinding[]> {
  if (!ctx.facts.loadSkillsStatus) return [];
  const status = await ctx.facts.loadSkillsStatus();
  if (status.ops.length === 0) {
    return [
      finding(
        "skills.bundle",
        "skills",
        "ok",
        "Skills Paseo installs match the bundle this daemon ships",
      ),
    ];
  }
  const by = (kind: string) => status.ops.filter((op) => op.kind === kind).map((op) => op.name);
  const detail = [
    by("update").length > 0 && `differ from the bundle: ${listed(by("update"))}`,
    by("add").length > 0 && `missing from at least one agent home: ${listed(by("add"))}`,
    by("delete").length > 0 && `retired but still installed: ${listed(by("delete"))}`,
  ]
    .filter(Boolean)
    .join("\n");
  return [
    finding(
      "skills.bundle",
      "skills",
      "warn",
      `${status.ops.length} Paseo-installed skill(s) are out of sync with the bundle`,
      {
        detail,
        why: "These describe Paseo's own tools and commands; a stale copy tells agents about behaviour the daemon no longer has.",
        fix: "Bozeo → Settings → Skills → Update",
      },
    ),
  ];
}

export const skillsCheck: DoctorCheck = {
  id: "skills",
  category: "skills",
  timeoutMs: 20_000,
  async run(ctx) {
    return [...checkMirrors(ctx), ...checkCanonicalSkills(ctx), ...(await checkManaged(ctx))];
  },
};
