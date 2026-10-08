import type { Command } from "commander";
import {
  BASIC_MEMORY_VERSION,
  basicMemoryDefaultFallbackBinDirs,
  execCommand,
  findExecutable,
  resolveBasicMemoryExecutable,
} from "@getpaseo/server";
import type { CommandOptions, OutputSchema, SingleResult } from "../../output/index.js";

/**
 * KTD-4: the only sanctioned install path. The daemon never installs software. A flat shape
 * (not a discriminated union) because `withOutput`'s generic distributes a union type argument
 * into a result type `T` cannot satisfy.
 */
export interface KbSetupReport {
  outcome: "uv-missing" | "installed";
  platform: NodeJS.Platform;
  installLine?: string;
  command?: string | null;
  version?: string;
  configBlock?: string;
  installLog?: string;
}

const CONFIG_BLOCK = JSON.stringify({ knowledgeBase: { enabled: true } }, null, 2);

/** The per-OS line KTD-4 specifies: Homebrew or the official script on macOS, winget on Windows. */
export function uvInstallLine(platform: NodeJS.Platform): string {
  return platform === "win32"
    ? "winget install astral-sh.uv"
    : "brew install uv\n  # or: curl -LsSf https://astral.sh/uv/install.sh | sh";
}

export async function runKbSetupCommand(
  _options: CommandOptions,
  _command: Command,
): Promise<SingleResult<KbSetupReport>> {
  const platform = process.platform;
  const uv = await findExecutable("uv");
  if (!uv) {
    process.exitCode = 1;
    return {
      type: "single",
      data: { outcome: "uv-missing", platform, installLine: uvInstallLine(platform) },
      schema: kbSetupSchema(),
    };
  }

  const install = await execCommand(
    uv,
    ["tool", "install", `basic-memory==${BASIC_MEMORY_VERSION}`, "--prerelease=allow"],
    { timeout: 5 * 60_000, maxBuffer: 1024 * 1024 },
  );
  const command = await resolveBasicMemoryExecutable(
    "basic-memory",
    basicMemoryDefaultFallbackBinDirs(),
  );
  return {
    type: "single",
    data: {
      outcome: "installed",
      platform,
      command,
      version: BASIC_MEMORY_VERSION,
      configBlock: CONFIG_BLOCK,
      installLog: `${install.stdout}${install.stderr}`.trim(),
    },
    schema: kbSetupSchema(),
  };
}

function renderKbSetupHuman(report: KbSetupReport): string {
  if (report.outcome === "uv-missing") {
    return [
      "uv is not on PATH. Install it, then run `paseo kb setup` again:",
      "",
      `  ${report.installLine}`,
    ].join("\n");
  }
  const lines = [`Basic Memory ${report.version} installed.`];
  lines.push(
    report.command ? `Binary: ${report.command}` : "Binary: not found on PATH after install.",
  );
  if (report.installLog) lines.push("", report.installLog);
  lines.push(
    "",
    "Add this to config.json, then `paseo daemon reload`:",
    "",
    report.configBlock ?? "",
  );
  return lines.join("\n");
}

function kbSetupSchema(): OutputSchema<KbSetupReport> {
  return {
    idField: () => "kb-setup",
    columns: [],
    renderHuman(result) {
      return result.type === "single" ? renderKbSetupHuman(result.data) : "";
    },
  };
}
