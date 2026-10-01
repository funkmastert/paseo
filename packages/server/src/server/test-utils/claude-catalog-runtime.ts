import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ProviderRuntimeSettings } from "@getpaseo/protocol/provider-config";

/**
 * Runtime settings that run the real Claude provider's catalog path without the real `claude`
 * binary: the command is Node running a script that prints a Claude Code version line, and the
 * config directory is empty. Cross-platform, and nothing reaches an account.
 */
export function createClaudeCatalogRuntimeSettings(dir: string): ProviderRuntimeSettings {
  const configDir = join(dir, "claude-config");
  mkdirSync(configDir, { recursive: true });
  const script = join(dir, "fake-claude.cjs");
  writeFileSync(script, 'process.stdout.write("2.1.0 (Claude Code)\\n");\n');
  return {
    command: { mode: "replace", argv: [process.execPath, script] },
    env: { CLAUDE_CONFIG_DIR: configDir },
  };
}
