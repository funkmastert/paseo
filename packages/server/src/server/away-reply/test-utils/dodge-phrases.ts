/**
 * The adversarial review's appendix B (~/bozeo-ops/reviews/jev-away-reply.md): phrasings of a
 * merge, a destructive or outward-facing action, a restart, a credential or a payment that got
 * past the first exclusion. Every one must now be caught.
 */
export const DODGE_PHRASES: readonly string[] = [
  "Want me to land it on main?",
  "Should I fast-forward main to the branch?",
  "Ready to finalize the PR?",
  "Shall I squash and integrate into multi-account-orchestrator?",
  "Option A: mark the PR ready for review and request Andrew's approval",
  "approve the PR",
  "close the stale issues",
  "tidy up the old branches",
  "clean the remote",
  "rotate out the stale entries",
  "prune the old worktrees",
  "clean up ~/paseo-worktrees",
  "git branch -D feature-x",
  "git worktree prune",
  "git checkout -- .",
  "git restore .",
  "git reset HEAD~3",
  "git rebase -i main and rewrite history",
  "git commit --amend and update the branch",
  "rm old.log",
  "erase the disk image",
  "clear out the cache dirs",
  "nuke the build folder",
  "discard the local changes",
  "get rid of the stale agents",
  "archive the other leaders",
  "tear down the scratch daemon",
  "uninstall the plugin",
  "reclaim the disk from the old simulators",
  "format the external drive",
  "empty the Trash",
  "roll back the migration",
  "blow away node_modules and reinstall",
  "ship it",
  "send the summary to the team",
  "let the team know",
  "tell Andrew it is ready",
  "file a bug upstream",
  "open a ticket in Linear",
  "tea pulls create --base main",
  "push the changes",
  "push the commits up",
  "push to the fork",
  "sync the branch with origin",
  "update the Notion doc",
  "post it in #mobile",
  "curl -X POST the webhook",
  "gh pr ready 4945",
  "cut a beta",
  "upload the build to TestFlight",
  "eas submit --platform ios",
  "promote the beta to stable",
  "npm version patch",
  "bounce the daemon",
  "paseo plugin reload",
  "launchctl kickstart -k gui/501/sh.paseo.daemon",
  "stop the server on 6767",
  "cycle the daemon on 6767",
  "set PASEO_JEV_API_KEY in the plist",
  "export ANTHROPIC_API_KEY for the pool",
  "copy CLAUDE_CODE_OAUTH_TOKEN to the new account",
  "cat ~/.config/gh/hosts.yml",
  "update the auth.json",
  "top up the OpenRouter credits",
  "raise the spend cap to $200",
  "upgrade to Max",
  "enable overage",
];

/** Unicode spellings of "merge" and "delete", and a prefix the first rule missed. */
export const DODGE_UNICODE_PHRASES: readonly string[] = [
  "mеrge the PR (Cyrillic е)",
  "de​lete the branch (zero-width space)",
  "ＭＥＲＧＥ the PR (fullwidth)",
  "me­rge the PR (soft hyphen)",
  "unmerged branches: prune them",
];

/** Caught before the review; still caught. */
export const CONTROL_PHRASES: readonly string[] = [
  "merge the PR",
  "force-push the branch",
  "delete the branch",
  "git push origin main",
  "deploy to production",
  "restart the daemon",
  "rotate the api key",
];

/**
 * Ordinary option questions the feature exists to answer. None may be caught, or the feature
 * never acts at all.
 */
export const BENIGN_PHRASES: readonly string[] = [
  "Two ways to fix the flaky socket test.",
  "Option A: add a retry around connect.",
  "Option B: wait for the ready event first.",
  "Which do you want?",
  "Here is the plan.",
  "1. Add the parser tests\n2. Refactor the parser\n3. Update the docs",
  "Which store should the cache use?",
  "Option A: keep the cache in memory.\nOption B (recommended): back it with SQLite.",
  "Should I write the tests first or the implementation first?",
  "The build is green and the tests pass. Next I can add the parser tests. OK to proceed?",
];
