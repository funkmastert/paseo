import type { Logger } from "pino";

import type { DeviceLaunchGate } from "../device-lease-manager.js";

import { GenericACPAgentClient } from "./generic-acp-agent.js";

interface TraeACPAgentClientOptions {
  logger: Logger;
  /** The device cap's launch gate; ACP is gated at the terminal and the permission request. */
  deviceLaunchGate?: DeviceLaunchGate;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

const TRAE_INITIAL_COMMANDS_WAIT_TIMEOUT_MS = 10_000;

export class TraeACPAgentClient extends GenericACPAgentClient {
  constructor(options: TraeACPAgentClientOptions) {
    super({
      logger: options.logger,
      deviceLaunchGate: options.deviceLaunchGate,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      // traecli publishes slash commands and skills asynchronously via available_commands_update.
      waitForInitialCommands: true,
      initialCommandsWaitTimeoutMs: TRAE_INITIAL_COMMANDS_WAIT_TIMEOUT_MS,
    });
  }
}
