import { z } from "zod";

// Extracted from messages.ts so non-checkout-anchored PR schemas (e.g.
// pull-requests/rpc-schemas.ts) can reuse the same canonical shape without importing the
// messages.ts root (which would be circular, since messages.ts imports domain rpc-schema files).

const CheckoutPrGithubAutoMergeRequestSchema = z
  .object({
    enabledAt: z.string().nullable().optional().default(null),
    mergeMethod: z.string().nullable().optional().default(null),
    enabledBy: z.string().nullable().optional().default(null),
  })
  .nullable()
  .optional()
  .default(null);

const CheckoutPrGithubRepositoryPolicySchema = z
  .object({
    autoMergeAllowed: z.boolean().optional().default(false),
    mergeCommitAllowed: z.boolean().optional().default(false),
    squashMergeAllowed: z.boolean().optional().default(false),
    rebaseMergeAllowed: z.boolean().optional().default(false),
    viewerDefaultMergeMethod: z.string().nullable().optional().default(null),
  })
  .optional()
  .default({
    autoMergeAllowed: false,
    mergeCommitAllowed: false,
    squashMergeAllowed: false,
    rebaseMergeAllowed: false,
    viewerDefaultMergeMethod: null,
  });

const CheckoutPrGithubStatusObjectSchema = z.object({
  mergeStateStatus: z.string().nullable().optional().default(null),
  autoMergeRequest: CheckoutPrGithubAutoMergeRequestSchema,
  viewerCanEnableAutoMerge: z.boolean().optional().default(false),
  viewerCanDisableAutoMerge: z.boolean().optional().default(false),
  viewerCanMergeAsAdmin: z.boolean().optional().default(false),
  viewerCanUpdateBranch: z.boolean().optional().default(false),
  repository: CheckoutPrGithubRepositoryPolicySchema,
  isMergeQueueEnabled: z.boolean().optional().default(false),
  isInMergeQueue: z.boolean().optional().default(false),
});

const CheckoutPrGithubStatusSchema = CheckoutPrGithubStatusObjectSchema.optional();

// The open facts envelope for forge-specific PR facts. Permanent — non-GitHub
// forges deliver their native facts through it. The transitional piece is the
// `github` mirror above, which stays populated for clients predating this
// envelope; see COMPAT(forgeSpecific) in status-projection.ts for the shim.
//
// NOTE: `forgeSpecific.forge` is a FACTS-FAMILY tag, not the workspace brand id.
// The whole Gitea family (gitea, forgejo, codeberg) emits `forge: "gitea"` here
// because they share one facts shape, while the top-level `forge` above carries
// the specific brand. Validation of family-specific payloads happens at runtime
// in the consumer that knows that forge family.
const CheckoutPrForgeSpecificSchema = z.unknown().optional();

export const CheckoutPrStatusSchema = z.object({
  // COMPAT(forge): added in v0.2.0-beta.1. Remove the GitHub default after
  // 2027-01-17 once the supported daemon floor is >= v0.2.0.
  forge: z.string().optional().default("github"),
  projectPath: z.string().optional(),
  number: z.number().optional(),
  url: z.string(),
  title: z.string(),
  state: z.string(),
  baseRefName: z.string(),
  headRefName: z.string(),
  isMerged: z.boolean(),
  isDraft: z.boolean().optional().default(false),
  mergeable: z
    .enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"])
    .catch("UNKNOWN")
    .optional()
    .default("UNKNOWN"),
  checks: z
    .array(
      z.object({
        name: z.string(),
        status: z.string(),
        url: z.string().nullable(),
        workflow: z.string().optional(),
        /**
         * Formatted by the forge adapter: how long a finished check took, or how long a
         * running one has been going. Raw timestamps stay off the wire.
         */
        duration: z.string().optional(),
        checkRunId: z.number().optional(),
        workflowRunId: z.number().optional(),
        // Open so future forge-neutral refinements remain parse-compatible.
        traits: z.array(z.string()).optional(),
      }),
    )
    .optional()
    .default([]),
  checksStatus: z.string().optional(),
  reviewDecision: z.string().nullable().optional(),
  repoOwner: z.string().optional(),
  repoName: z.string().optional(),
  github: CheckoutPrGithubStatusSchema,
  forgeSpecific: CheckoutPrForgeSpecificSchema,
});
