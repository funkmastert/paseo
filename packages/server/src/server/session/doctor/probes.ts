import { execFile } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";
import path from "node:path";
import { claudeConfigDirKeychainService } from "../../../services/quota-fetcher/providers/claude.js";
import type { DoctorProbes } from "./context.js";
import { measureDirBytes } from "./measure-dir.js";

const KEYCHAIN_TIMEOUT_MS = 5_000;

function keychainItemExists(service: string): Promise<boolean> {
  // Attribute lookup only: no -w or -g, so the secret is never read or printed.
  return new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", service],
      { timeout: KEYCHAIN_TIMEOUT_MS },
      (error) => resolve(!error),
    );
  });
}

export function createRealProbes(): DoctorProbes {
  return {
    async statfs(target) {
      let probe = target;
      while (!existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
      const stats = statfsSync(probe);
      return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
    },
    measureDirBytes,
    exec(file, args, options) {
      return new Promise((resolve) => {
        execFile(
          file,
          [...args],
          {
            timeout: options.timeoutMs,
            cwd: options.cwd,
            env: options.env,
            maxBuffer: 32 * 1024 * 1024,
          },
          (error, stdout, stderr) => {
            const code = error ? (error as NodeJS.ErrnoException & { code?: unknown }).code : 0;
            // A spawn failure or a timeout kill has no exit code; a program that ran and failed does.
            if (error && (typeof code !== "number" || (error as { killed?: boolean }).killed)) {
              resolve(null);
              return;
            }
            resolve({ stdout, stderr, code: typeof code === "number" ? code : 0 });
          },
        );
      });
    },
    async hasCredentials({ configDir, keychainService }) {
      if (existsSync(path.join(configDir, ".credentials.json"))) return true;
      if (process.platform !== "darwin") return null;
      // A provider that sets CLAUDE_CONFIG_DIR gets a per-dir item even when the dir is ~/.claude;
      // the plain item belongs to a Claude Code run with no CLAUDE_CONFIG_DIR at all.
      const services = keychainService
        ? [keychainService]
        : [claudeConfigDirKeychainService(configDir), "Claude Code-credentials"];
      for (const service of services) {
        if (await keychainItemExists(service)) return true;
      }
      return false;
    },
  };
}
