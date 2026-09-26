import type { ProviderOptions, ToolPolicy } from "@getpaseo/protocol/agent-types";
import { z } from "zod";

const PermissionRulesSchema = z
  .object({
    allow: z.array(z.string()).optional(),
    ask: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  })
  .strict();

const SandboxNetworkSchema = z
  .object({
    allowedDomains: z.array(z.string()).optional(),
    deniedDomains: z.array(z.string()).optional(),
    strictAllowlist: z.boolean().optional(),
    allowManagedDomainsOnly: z.boolean().optional(),
    allowUnixSockets: z.array(z.string()).optional(),
    allowAllUnixSockets: z.boolean().optional(),
    allowLocalBinding: z.boolean().optional(),
    allowMachLookup: z.array(z.string()).optional(),
    httpProxyPort: z.number().int().positive().optional(),
    socksProxyPort: z.number().int().positive().optional(),
    tlsTerminate: z
      .object({
        caCertPath: z.string().optional(),
        caKeyPath: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const SandboxFilesystemSchema = z
  .object({
    allowWrite: z.array(z.string()).optional(),
    denyWrite: z.array(z.string()).optional(),
    denyRead: z.array(z.string()).optional(),
    allowRead: z.array(z.string()).optional(),
    allowManagedReadPathsOnly: z.boolean().optional(),
    disabled: z.boolean().optional(),
  })
  .strict();

/**
 * `agents.providers.claude.params`: Paseo-owned knobs for the built-in Claude provider, read once
 * per client. The object stays open because other owners keep their own keys in the same slot
 * (the account-pool plugin's `accountPool`). docs/custom-providers.md "Claude `params`".
 */
export const ClaudeProviderParamsSchema = z.object({
  // Default on. Moves cwd, platform, shell and git status out of the system prompt and into
  // the first user message, so sessions in different worktrees share one cached prefix.
  excludeDynamicSections: z.boolean().default(true),
});

export type ClaudeProviderParams = z.infer<typeof ClaudeProviderParamsSchema>;

// Claude Agent SDK Options, maintained against @anthropic-ai/claude-agent-sdk 0.3.246.
export const ClaudeProviderOptionsSchema = z
  .object({
    allowedTools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    // Paseo-owned, not an SDK option. The SDK's own channel is
    // `systemPrompt: { type: "preset", preset: "claude_code", append }`, a single
    // string that the daemon already spends on the user's `systemPrompt` and the
    // daemon-wide `daemon.appendSystemPrompt`. A caller that restricts an agent
    // through the other options here — `disallowedTools` above, `sandbox`,
    // `settings.permissions` — has no way to tell the agent it did, and an agent
    // that has to discover its own restrictions by hitting them burns tokens
    // doing it. This field is the supported way to say so. `buildOptions()`
    // strips it and folds it into that one `append` string, so it never reaches
    // the SDK as an unknown key and never clobbers the other two parts.
    appendSystemPrompt: z.string().optional(),
    additionalDirectories: z.array(z.string()).optional(),
    sandbox: z
      .object({
        enabled: z.boolean().optional(),
        failIfUnavailable: z.boolean().optional(),
        autoAllowBashIfSandboxed: z.boolean().optional(),
        excludedCommands: z.array(z.string()).optional(),
        allowUnsandboxedCommands: z.boolean().optional(),
        network: SandboxNetworkSchema.optional(),
        filesystem: SandboxFilesystemSchema.optional(),
        ignoreViolations: z.record(z.string(), z.array(z.string())).optional(),
        enableWeakerNestedSandbox: z.boolean().optional(),
        ripgrep: z
          .object({ command: z.string(), args: z.array(z.string()).optional() })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    settings: z
      .object({
        // A Claude Code output style by name. The account-pool plugin sets the
        // built-in "Concise" on classifier-routed child agents; the CLI reads it
        // from `--settings`. An unknown name is the CLI's to ignore, not ours to
        // validate: the built-in set differs by CLI version.
        outputStyle: z.string().min(1).optional(),
        permissions: PermissionRulesSchema.optional(),
        sandbox: z
          .object({
            enabled: z.boolean().optional(),
            failIfUnavailable: z.boolean().optional(),
            autoAllowBashIfSandboxed: z.boolean().optional(),
            excludedCommands: z.array(z.string()).optional(),
            allowUnsandboxedCommands: z.boolean().optional(),
            network: SandboxNetworkSchema.optional(),
            filesystem: SandboxFilesystemSchema.optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict() satisfies z.ZodType<ProviderOptions>;

export type ClaudeProviderOptions = z.infer<typeof ClaudeProviderOptionsSchema>;

export function applyClaudeToolPolicy(
  options: ClaudeProviderOptions,
  toolPolicy: ToolPolicy | undefined,
): ClaudeProviderOptions {
  if (!toolPolicy) return options;
  const allowedTools = Array.isArray(options.allowedTools)
    ? options.allowedTools.filter((tool): tool is string => typeof tool === "string")
    : [];
  const grants = toolPolicy.preapproved.map((grant) => `mcp__${grant.server}__${grant.tool}`);
  return { ...options, allowedTools: [...new Set([...allowedTools, ...grants])] };
}
