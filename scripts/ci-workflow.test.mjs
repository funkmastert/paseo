import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { relative as relativePath } from "node:path";
import test from "node:test";

const repoRoot = new URL("../", import.meta.url);
const ciWorkflowPath = new URL(".github/workflows/ci.yml", repoRoot);
const dockerWorkflowPath = new URL(".github/workflows/docker.yml", repoRoot);
const nixWorkflowPath = new URL(".github/workflows/nix.yml", repoRoot);
const filtersPath = new URL(".github/ci-paths.yml", repoRoot);
const serverTsconfigPath = new URL("packages/server/tsconfig.server.json", repoRoot);
const serverPackagePath = new URL("packages/server/package.json", repoRoot);
const desktopPackagePath = new URL("packages/desktop/package.json", repoRoot);

// Frozen pre-CI backlog: these files existed before anything in CI ever ran
// `test:integration` or `test:e2e` for packages/server, so none of them are
// known-green. This set may only shrink (a file leaves it once it is wired
// into test:integration, or deleted) — see "no new e2e file goes untested"
// below. New e2e files must never be added here; add them to
// packages/server/package.json's test:integration script, or suffix them
// .real.e2e.test.ts / .local.e2e.test.ts if they need live provider
// credentials or a local-only resource (docs/testing.md's naming table).
const UNWIRED_SERVER_E2E_BACKLOG = new Set([
  "packages/server/src/server/agent-account-failover-monitor.e2e.test.ts",
  "packages/server/src/server/agent-done-janitor.e2e.test.ts",
  "packages/server/src/server/agent/activity-summary-recovery.e2e.test.ts",
  "packages/server/src/server/agent/agent-mcp.e2e.test.ts",
  "packages/server/src/server/agent/mcp-parity.e2e.test.ts",
  "packages/server/src/server/agent/opencode-reasoning.e2e.test.ts",
  "packages/server/src/server/agent/provider-move.e2e.test.ts",
  "packages/server/src/server/agent/providers/claude/agent-commands.e2e.test.ts",
  "packages/server/src/server/agent/providers/codex-mcp-agent-commands.e2e.test.ts",
  "packages/server/src/server/agent/providers/opencode-agent-commands.e2e.test.ts",
  "packages/server/src/server/cli-run-workspace-precedence.e2e.test.ts",
  "packages/server/src/server/client-activity.e2e.test.ts",
  "packages/server/src/server/daemon-client.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/agent-basics.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/agent-operations.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/agent-refresh-rehydrates-timeline.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/agent-rpc-durability.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/checkout-diff-subscription.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/checkout-pr-merge.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/checkout-ship.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/claude-live-usage.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/connection-offer.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/daemon-restart-resume.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/empty-project-persists.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/file-download.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/filesystem.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/git-operations.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/images.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/mode-switch-propagation.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/open-project-missing-directory.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/open-project-worktree-reclassification.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/orchestration.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/permissions-claude.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/permissions-codex.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/persistence.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/project-becomes-git.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/relay-transport.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/streaming.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/terminal-byte-headless-parity.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/terminal.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/timeline-reconnect-contract.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/timeline-window.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/tool-calls.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/two-cycle-resume.e2e.test.ts",
  "packages/server/src/server/daemon-e2e/wait-for-idle.e2e.test.ts",
  "packages/server/src/server/plugins/agent-configuration.e2e.test.ts",
  "packages/server/src/server/plugins/connection-demand.e2e.test.ts",
  "packages/server/src/server/plugins/lifecycle-archive.e2e.test.ts",
  "packages/server/src/server/plugins/lifecycle.e2e.test.ts",
  "packages/server/src/server/plugins/plugin-paseo-api.e2e.test.ts",
  "packages/server/src/server/plugins/plugin-session-drop-recovery.e2e.test.ts",
  "packages/server/src/server/plugins/settings.e2e.test.ts",
  "packages/server/src/server/schedule-run-lifecycle.e2e.test.ts",
  "packages/server/src/server/selective-timeline-delivery.e2e.test.ts",
  "packages/server/src/server/speech/providers/local/sherpa/speech-download.e2e.test.ts",
  "packages/server/src/server/voice-local-agent.e2e.test.ts",
  "packages/server/src/server/voice-roundtrip.e2e.test.ts",
  "packages/server/src/server/websocket-server.file-transfer.e2e.test.ts",
  "packages/server/src/server/websocket-server.liveness.e2e.test.ts",
  "packages/server/src/server/workspace-archive-record-scoped.e2e.test.ts",
  "packages/server/src/server/workspace-create-errors.e2e.test.ts",
  "packages/server/src/server/workspace-create-worktree-source.e2e.test.ts",
  "packages/server/src/server/workspace-same-cwd-isolation.e2e.test.ts",
]);
const UNWIRED_SERVER_E2E_BACKLOG_FROZEN_SIZE = 63;

const gatedCiJobs = new Map([
  ["format", { name: "format", contract: "format" }],
  ["lint", { name: "lint", contract: "quality" }],
  ["typecheck", { name: "typecheck", contract: "quality" }],
  [
    "server-tests-ubuntu",
    { name: "server-tests (ubuntu-latest)", contracts: ["server", "hub", "plugin"] },
  ],
  [
    "server-tests-windows",
    { name: "server-tests (windows-latest)", contracts: ["server", "hub", "plugin"] },
  ],
  ["desktop-tests-ubuntu", { name: "desktop-tests (ubuntu-latest)", contract: "desktop" }],
  ["desktop-tests-windows", { name: "desktop-tests (windows-latest)", contract: "desktop" }],
  ["app-tests", { name: "app-tests", contract: "app" }],
  ["sdk-tests", { name: "sdk-tests", contract: "sdk" }],
  ["playwright-1", { name: "playwright (shard 1/4)", contract: "browser" }],
  ["playwright-2", { name: "playwright (shard 2/4)", contract: "browser" }],
  ["playwright-3", { name: "playwright (shard 3/4)", contract: "browser" }],
  ["playwright-4", { name: "playwright (shard 4/4)", contract: "browser" }],
  ["relay-tests", { name: "relay-tests", contract: "relay" }],
  ["plugin-tests", { name: "plugin-tests", contract: "plugin" }],
  ["cli-tests-1", { name: "cli-tests (shard 1/3)", contract: "cli" }],
  ["cli-tests-2", { name: "cli-tests (shard 2/3)", contract: "cli" }],
  ["cli-tests-3", { name: "cli-tests (shard 3/3)", contract: "cli" }],
]);

function jobBlocks(source) {
  const jobs = new Map();
  let currentJob;

  for (const line of source.split("\n")) {
    const jobMatch = /^  ([a-z0-9-]+):\s*$/.exec(line);
    if (jobMatch) {
      currentJob = jobMatch[1];
      jobs.set(currentJob, []);
      continue;
    }
    if (currentJob) jobs.get(currentJob).push(line);
  }
  return jobs;
}

function loadFilters(path) {
  const filters = {};
  let currentFilter;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const filterMatch = /^([a-z_]+):\s*$/.exec(line);
    if (filterMatch) {
      currentFilter = filterMatch[1];
      filters[currentFilter] = [];
      continue;
    }
    const patternMatch = /^  - "([^"]+)"\s*$/.exec(line);
    if (currentFilter && patternMatch) filters[currentFilter].push(patternMatch[1]);
  }
  return filters;
}

function filesUnder(relativeDirectory, predicate) {
  const directory = new URL(`${relativeDirectory}/`, repoRoot);
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      [relativeDirectory, relativePath(directory.pathname, entry.parentPath), entry.name]
        .filter(Boolean)
        .join("/")
        .replaceAll("\\", "/"),
    )
    .filter(predicate)
    .sort();
}

test("gated checks are statically named jobs with real job-level gating", () => {
  const workflowSource = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(workflowSource);
  const trigger = workflowSource.split("jobs:", 1)[0];

  assert.match(trigger, /^\s+merge_group:\s*$/m);
  assert.doesNotMatch(workflowSource, /strategy:\s*\n\s+matrix:/);
  assert.doesNotMatch(workflowSource, /RUN_TESTS|Skip unaffected|No .* changes detected/);

  for (const [jobId, expected] of gatedCiJobs) {
    const job = jobs.get(jobId)?.join("\n");
    assert.ok(job, `missing static job ${jobId}`);
    assert.match(job, new RegExp(`^    name: ${expected.name.replace(/[()]/g, "\\$&")}$`, "m"));
    assert.match(job, /needs\.changes\.outputs\.full != 'false'/);
    for (const contract of expected.contracts ?? [expected.contract]) {
      assert.match(job, new RegExp(`needs\\.changes\\.outputs\\.${contract} != 'false'`));
    }
  }
});

test("change gating allows superseded workflow runs to cancel", () => {
  for (const workflowPath of [ciWorkflowPath, dockerWorkflowPath, nixWorkflowPath]) {
    const source = readFileSync(workflowPath, "utf8");
    assert.doesNotMatch(
      source,
      /\$\{\{\s*always\(\)/,
      "always() keeps jobs alive after concurrency cancellation; use !cancelled() for fail-open gating",
    );
  }
});

test("focused contracts stay inside existing required checks", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const changes = jobs.get("changes")?.join("\n") ?? "";
  const server = jobs.get("server-tests-ubuntu")?.join("\n") ?? "";
  const desktop = jobs.get("desktop-tests-ubuntu")?.join("\n") ?? "";

  assert.match(changes, /scripts\/daemon-launch-contract\.test\.mjs/);
  assert.doesNotMatch(changes, /Install dependencies|npm run build/);

  assert.match(server, /test:hub-cli-contract/);
  assert.match(server, /npm run test --workspace=@getpaseo\/server/);
  assert.ok(!jobs.has("hub-cli-contract"));

  assert.match(desktop, /test:e2e:renderer/);
  assert.match(desktop, /test:e2e:browser-tabs/);
  assert.match(desktop, /npm run test --workspace=@getpaseo\/desktop/);
  assert.ok(!jobs.has("desktop-browser-bridge"));
  assert.ok(!jobs.has("playwright-desktop"));
});

test("server builds exclude test utilities at every domain depth", () => {
  const tsconfig = JSON.parse(readFileSync(serverTsconfigPath, "utf8"));
  assert.ok(tsconfig.exclude.includes("src/server/**/test-utils/**"));
  assert.ok(!tsconfig.exclude.includes("src/server/test-utils/**"));
});

test("PR routing declares stable behavior ownership", () => {
  const filters = loadFilters(filtersPath);
  assert.deepEqual(filters, {
    routing: [".github/ci-paths.yml"],
    workspace: [
      ".mise.toml",
      ".tool-versions",
      "package.json",
      "package-lock.json",
      "patches/**",
      "scripts/**",
      "tsconfig.json",
      "tsconfig.base.json",
      "vitest.config.ts",
    ],
    ci: [".github/actions/**", ".github/workflows/ci.yml"],
    format: [
      ".agents/**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      ".github/**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      "**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      "packages/expo-two-way-audio/**",
    ],
    quality: ["**/*.{cjs,js,json,jsx,mjs,ts,tsx}", "packages/expo-two-way-audio/**"],
    hub: ["packages/cli/src/commands/hub/**", "packages/server/src/server/hub/**"],
    server: ["packages/server/**", "packages/app/e2e/support/fixtures/recording.*"],
    desktop: [
      "packages/desktop/**",
      "packages/app/src/desktop/**",
      "packages/server/src/server/browser-tools/**",
      "packages/app/e2e/support/**",
      "packages/app/*config.{cjs,js,ts}",
      "packages/app/package.json",
    ],
    app: ["packages/app/**", "packages/expo-two-way-audio/**"],
    sdk: [
      "packages/plugin/**",
      "plugin-examples/**",
      "public-docs/plugins/v0.8/**",
      "packages/client/**",
      "packages/highlight/**",
      "packages/protocol/**",
    ],
    browser: [
      "packages/server/src/server/agent/provider-snapshot-manager.ts",
      "packages/server/src/server/session/provider/provider-catalog-session.ts",
      "packages/client/src/compat/normalize-provider-models.ts",
      "packages/protocol/src/client-capabilities.ts",
      "packages/server/src/server/agent/provider-registry.ts",
      "packages/server/src/server/agent/agent-sdk-types.ts",
      "packages/server/src/server/agent/providers/codex-app-server-agent.ts",
      "packages/server/src/server/agent/providers/claude/agent.ts",
      "packages/server/src/server/agent/plugin-provider.ts",
      "packages/server/src/server/plugins/{index,plugin-process,plugin-process-protocol,runtime}.ts",
      "packages/server/src/executable-resolution/**",
      "packages/plugin/src/server/provider.ts",
      "packages/app/src/!(desktop)/**",
      "packages/app/e2e/browser/**",
      "packages/app/e2e/support/**",
      "packages/app/assets/**",
      "packages/app/public/**",
      "packages/app/index.ts",
      "packages/app/*config.{cjs,js,ts}",
      "packages/app/package.json",
    ],
    relay: ["packages/relay/**"],
    plugin: ["plugins/claude-account-pool/**", "packages/plugin/**"],
    cli: ["packages/cli/**"],
  });
});

test("no server e2e file goes untested without a deliberate decision", () => {
  const files = filesUnder(
    "packages/server/src",
    (path) => path.endsWith(".e2e.test.ts") && !/\.(real|local)\.e2e\.test\.ts$/.test(path),
  );
  assert.ok(files.length > 0);

  const serverPackage = JSON.parse(readFileSync(serverPackagePath, "utf8"));
  const integrationScript = serverPackage.scripts["test:integration"];
  assert.ok(integrationScript, "packages/server/package.json is missing a test:integration script");

  const unwired = files.filter((path) => {
    const scriptRelativePath = path.replace(/^packages\/server\//, "");
    return !integrationScript.includes(scriptRelativePath);
  });

  const newlyUnwired = unwired.filter((path) => !UNWIRED_SERVER_E2E_BACKLOG.has(path));
  assert.deepEqual(
    newlyUnwired,
    [],
    "New e2e file(s) exist on disk but nothing in CI runs them: " +
      newlyUnwired.join(", ") +
      ". Add each file to packages/server/package.json's test:integration " +
      "script so it runs on every PR, or rename it with a .real.e2e.test.ts " +
      "/ .local.e2e.test.ts suffix if it needs live provider credentials or " +
      "a local-only resource (see docs/testing.md's naming table). Do not " +
      "add it to UNWIRED_SERVER_E2E_BACKLOG in scripts/ci-workflow.test.mjs " +
      "— that set is a frozen pre-CI backlog, not a place to park new debt.",
  );

  const staleBacklogEntries = [...UNWIRED_SERVER_E2E_BACKLOG].filter(
    (path) => !unwired.includes(path),
  );
  assert.deepEqual(
    staleBacklogEntries,
    [],
    "UNWIRED_SERVER_E2E_BACKLOG in scripts/ci-workflow.test.mjs lists file(s) " +
      "that are already wired into test:integration or no longer exist on " +
      "disk: " +
      staleBacklogEntries.join(", ") +
      ". Remove them from the set — it may only shrink.",
  );

  assert.ok(
    UNWIRED_SERVER_E2E_BACKLOG.size <= UNWIRED_SERVER_E2E_BACKLOG_FROZEN_SIZE,
    "UNWIRED_SERVER_E2E_BACKLOG grew past its frozen pre-CI size. A new e2e " +
      "file must be wired into test:integration (or tagged .real./.local.), " +
      "not parked in the backlog — the backlog only ever shrinks as entries " +
      "get triaged.",
  );
});

test("cross-package invariants live in the suite that owns them", () => {
  const cliTests = filesUnder("packages/cli", (path) => path.endsWith(".test.ts"));
  assert.ok(cliTests.length > 0);
  for (const path of cliTests) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /server\/src\/server\/test-utils/,
      path,
    );
  }

  const protocolWireCompatibility = new URL(
    "packages/protocol/src/messages.wire-compat.test.ts",
    repoRoot,
  );
  assert.match(readFileSync(protocolWireCompatibility, "utf8"), /wire schema compatibility/);
});

test("browser and desktop tests have exclusive, directory-owned suites", () => {
  const filters = loadFilters(filtersPath);
  const browserSpecs = filesUnder("packages/app/e2e", (path) => path.endsWith(".spec.ts"));
  const desktopSpecs = filesUnder("packages/desktop/e2e", (path) => path.endsWith(".spec.ts"));
  const electronModules = filesUnder("packages/app/src", (path) => /\.electron\.tsx?$/.test(path));

  assert.ok(browserSpecs.length > 0);
  assert.ok(desktopSpecs.length > 0);
  assert.ok(browserSpecs.every((path) => path.startsWith("packages/app/e2e/browser/")));
  assert.ok(desktopSpecs.every((path) => path.startsWith("packages/desktop/e2e/")));
  assert.ok(electronModules.every((path) => path.startsWith("packages/app/src/desktop/")));

  const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, "utf8"));
  assert.match(desktopPackage.scripts.test, /--exclude ["']e2e\/\*\*["']/);

  for (const path of browserSpecs) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /paseoDesktop|injectDesktopBridge/,
    );
  }
  for (const path of desktopSpecs) {
    assert.ok(path.startsWith("packages/desktop/e2e/"));
  }

  const routingSource = readFileSync(filtersPath, "utf8");
  assert.doesNotMatch(routingSource, /desktop_bridge|playwright_desktop|browser-\*|browser-\*\//);
  assert.deepEqual(filters.desktop, [
    "packages/desktop/**",
    "packages/app/src/desktop/**",
    "packages/server/src/server/browser-tools/**",
    "packages/app/e2e/support/**",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
  assert.deepEqual(filters.browser, [
    "packages/server/src/server/agent/provider-snapshot-manager.ts",
    "packages/server/src/server/session/provider/provider-catalog-session.ts",
    "packages/client/src/compat/normalize-provider-models.ts",
    "packages/protocol/src/client-capabilities.ts",
    "packages/server/src/server/agent/provider-registry.ts",
    "packages/server/src/server/agent/agent-sdk-types.ts",
    "packages/server/src/server/agent/providers/codex-app-server-agent.ts",
    "packages/server/src/server/agent/providers/claude/agent.ts",
    "packages/server/src/server/agent/plugin-provider.ts",
    "packages/server/src/server/plugins/{index,plugin-process,plugin-process-protocol,runtime}.ts",
    "packages/server/src/executable-resolution/**",
    "packages/plugin/src/server/provider.ts",
    "packages/app/src/!(desktop)/**",
    "packages/app/e2e/browser/**",
    "packages/app/e2e/support/**",
    "packages/app/assets/**",
    "packages/app/public/**",
    "packages/app/index.ts",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
});

test("non-required Docker and Nix workflows avoid runners with workflow path filters", () => {
  for (const workflowPath of [dockerWorkflowPath, nixWorkflowPath]) {
    const source = readFileSync(workflowPath, "utf8");
    const trigger = source.split("jobs:", 1)[0];
    assert.match(trigger, /^\s+paths:\s*$/m);
    assert.doesNotMatch(source, /dorny\/paths-filter/);
  }
});
