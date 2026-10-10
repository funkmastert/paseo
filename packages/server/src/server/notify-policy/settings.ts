import type pino from "pino";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import {
  NotifyPolicySettingsSchema,
  type NotifyPolicySettings,
} from "@getpaseo/protocol/notify-policy/types";

import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";

export const DEFAULT_NOTIFY_POLICY_SETTINGS: NotifyPolicySettings = {
  minPostLevel: "notice",
  minInterruptLevel: "alert",
  digestIntervalMinutes: 30,
  availability: { mode: "available", until: null },
};

const StoredSettingsSchema = z.object({ settings: NotifyPolicySettingsSchema.partial() });

/**
 * The notify policy's settings, persisted next to the push tokens. They live in their own file
 * rather than the daemon config because the availability toggle changes all day from the app.
 * Missing or unreadable state falls back to the defaults, which are quieter than the daemon was
 * before the policy existed.
 */
export class NotifyPolicySettingsStore {
  private settings: NotifyPolicySettings = DEFAULT_NOTIFY_POLICY_SETTINGS;
  private readonly logger: pino.Logger;

  constructor(
    logger: pino.Logger,
    private readonly filePath: string,
    private readonly write: typeof writePrivateFileAtomicSync = writePrivateFileAtomicSync,
  ) {
    this.logger = logger.child({ component: "notify-policy-settings" });
    this.load();
  }

  get(): NotifyPolicySettings {
    return this.settings;
  }

  update(patch: Partial<NotifyPolicySettings>): NotifyPolicySettings {
    const next = { ...this.settings, ...definedOnly(patch) };
    this.write(this.filePath, JSON.stringify({ settings: next }, null, 2) + "\n");
    this.settings = next;
    return next;
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      ensurePrivateFile(this.filePath);
      const parsed = StoredSettingsSchema.parse(JSON.parse(readFileSync(this.filePath, "utf-8")));
      this.settings = { ...DEFAULT_NOTIFY_POLICY_SETTINGS, ...definedOnly(parsed.settings) };
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to load notify policy settings; using defaults");
    }
  }
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
