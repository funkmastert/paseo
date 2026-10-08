import { existsSync } from "node:fs";
import { access, constants as fsConstants } from "node:fs/promises";
import path from "node:path";

import { findExecutable } from "../../../executable-resolution/executable-resolution.js";
import {
  BASIC_MEMORY_VERSION,
  defaultFallbackBinDirs,
  resolveBasicMemoryExecutable,
} from "../../knowledge-base/basic-memory-sidecar.js";
import { resolveKnowledgeBaseConfig } from "../../knowledge-base/config.js";
import { finding, type DoctorCheck } from "./context.js";

/**
 * `knowledgeBase` (docs/knowledge-base.md, KTD-4). Off by default, so an absent or disabled
 * section reports nothing. Never runs the `basic-memory` binary: `--version` initializes its
 * config directory as a side effect (confirmed against 0.23.2 without the sidecar's lockdown
 * env), which doctor must not do. The installed version instead comes from `uv tool list`, a
 * read of uv's own manifest.
 */

const ID = "knowledgeBase.basicMemory";
const CATEGORY = "knowledgeBase";
const UV_TIMEOUT_MS = 10_000;

function writableAncestor(target: string): string {
  let probe = target;
  while (!existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  return probe;
}

async function checkNotesDirWritable(notesDir: string) {
  const probe = writableAncestor(notesDir);
  try {
    await access(probe, fsConstants.W_OK);
    return finding(ID, CATEGORY, "ok", `Notes directory is writable: ${notesDir}`);
  } catch {
    return finding(ID, CATEGORY, "fail", `Notes directory is not writable: ${notesDir}`, {
      detail: `Neither ${notesDir} nor its nearest existing ancestor (${probe}) can be written to.`,
      why: "Filing links, agent writes and Tyler's edits in the view all go through one write path onto this directory.",
      fix: `Fix permissions on ${probe}, or point knowledgeBase.notesDir elsewhere and \`paseo daemon reload\`.`,
    });
  }
}

/** `basic-memory v0.23.2` in `uv tool list` output, or null when the tool isn't listed. */
function parseUvToolVersion(stdout: string, toolName: string): string | null {
  const pattern = new RegExp(`^${toolName}\\s+v?(\\S+)`, "m");
  return pattern.exec(stdout)?.[1] ?? null;
}

export const knowledgeBaseCheck: DoctorCheck = {
  id: ID,
  category: CATEGORY,
  timeoutMs: UV_TIMEOUT_MS + 5_000,
  async run(ctx) {
    const config = resolveKnowledgeBaseConfig(ctx.rawConfig?.["knowledgeBase"], {
      paseoHome: ctx.paseoHome,
    });
    if (!config.enabled) return [];

    const out = [await checkNotesDirWritable(path.resolve(config.notesDir))];

    const command = await resolveBasicMemoryExecutable(
      config.basicMemory.command,
      defaultFallbackBinDirs(),
    );
    if (!command) {
      out.push(
        finding(ID, CATEGORY, "fail", "Basic Memory is not installed", {
          detail: `knowledgeBase.basicMemory.command ("${config.basicMemory.command}") does not resolve to an executable.`,
          why: "The sidecar cannot start, so kb_search, kb_open and kb_create all answer unavailable.",
          fix: "paseo kb setup",
        }),
      );
      return out;
    }

    const uv = await findExecutable("uv");
    if (!uv) {
      out.push(
        finding(ID, CATEGORY, "warn", `Basic Memory found at ${command}; its version is unknown`, {
          detail: "uv is not on PATH, so its version cannot be checked against the pin this way.",
          fix: "paseo kb setup",
        }),
      );
      return out;
    }

    const result = await ctx.probes.exec(uv, ["tool", "list"], {
      timeoutMs: UV_TIMEOUT_MS,
      env: ctx.env,
    });
    const version = result ? parseUvToolVersion(result.stdout, "basic-memory") : null;
    if (version === null) {
      out.push(
        finding(ID, CATEGORY, "warn", `Basic Memory found at ${command}; its version is unknown`, {
          detail: result
            ? "uv tool list does not list basic-memory (installed another way, outside uv's management)."
            : "uv tool list did not run or did not finish in time.",
          fix: "paseo kb setup",
        }),
      );
    } else if (version !== BASIC_MEMORY_VERSION) {
      out.push(
        finding(
          ID,
          CATEGORY,
          "warn",
          `Basic Memory ${version} is installed; the pin is ${BASIC_MEMORY_VERSION}`,
          {
            detail: `${command} reports ${version} through uv tool list.`,
            fix: "paseo kb setup",
          },
        ),
      );
    } else {
      out.push(finding(ID, CATEGORY, "ok", `Basic Memory ${version} at ${command}`));
    }
    return out;
  },
};
