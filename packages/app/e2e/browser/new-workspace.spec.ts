import { existsSync } from "node:fs";
import path from "node:path";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  archiveWorkspaceFromDaemon,
  archiveLocalWorkspaceFromDaemon,
  assertNewWorkspaceSidebarAndHeader,
  closeBranchPicker,
  connectNewWorkspaceDaemonClient,
  createWorktreeViaDaemon,
  delayBrowserAgentCreatedStatus,
  expectComposerGithubAttachmentPill,
  expectNewWorkspaceProjectSelected,
  expectPickerClosed,
  expectPickerOpen,
  expectPickerSelected,
  expectStartingRefPickerTriggerPr,
  fillNewWorkspaceDraft,
  openGlobalNewWorkspaceComposer,
  openBranchPicker,
  openNewWorkspaceComposer,
  openProjectViaDaemon,
  openStartingRefPicker,
  pasteGithubPrUrl,
  captureStartingRefPicker,
  expectStartingRefRows,
  startingRefRow,
  submitNewWorkspaceEmpty,
  searchAndSelectBranchInPicker,
  selectBranchInPicker,
  selectGitHubPrInPicker,
  selectPickerOptionByKeyboard,
  selectWorkspaceIsolation,
  submitNewWorkspacePrompt,
} from "../support/helpers/new-workspace";
import {
  commitLocalOnly,
  createTempGitRepo,
  readRepoRef,
  readWorktreeBaseMetadata,
  readWorktreeBranchInfo,
  trackForkUpstream,
} from "../support/helpers/workspace";
import {
  createLocalGithubPrFixture,
  cloneGithubRepoDefaultBranchOnly,
  createTempGithubRepo,
  hasGithubAuth,
  type LocalGhPrFixture,
} from "../support/helpers/github-fixtures";
import { getServerId } from "../support/helpers/server-id";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import { chooseAddProjectMethod, expectAddProjectPage } from "../support/helpers/add-project-flow";
import { seedSavedSettingsHosts } from "../support/helpers/settings";
import {
  expectSidebarWorkspaceSelected,
  expectWorkspaceHeader,
  switchWorkspaceViaSidebar,
  waitForSidebarHydration,
  waitForWorkspaceInSidebar,
} from "../support/helpers/workspace-ui";
import { dropFileOnComposer, expectAttachmentPill } from "../support/helpers/composer";

const BACKGROUND_RESOLUTION_FILE = {
  name: "background-context.json",
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify({ composer: "background-resolution" })),
};

interface PinnedRowStatusEvent {
  rowTestId: string;
  hasStatusBadge: boolean;
  statusLabel: string | null;
  at: number;
}

// A session-start auto pin (workspace-auto-pin.ts) hoists a newly created workspace straight into
// the sidebar's Pinned section, which sits outside every status bucket. A pinned row shows its
// status via `project-status-badge` (role="status") rather than `workspace-status-indicator-*`,
// and that badge is omitted entirely for the "done" bucket — so "never looks done" reads as "the
// badge is never absent" while this tracker is running.
async function startTrackingPinnedRowStatus(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    interface StatusEvent {
      rowTestId: string;
      hasStatusBadge: boolean;
      statusLabel: string | null;
      at: number;
    }
    const win = window as typeof window & {
      __pinnedRowStatusEvents?: StatusEvent[];
      __pinnedRowStatusObserver?: MutationObserver;
    };
    win.__pinnedRowStatusEvents = [];
    win.__pinnedRowStatusObserver?.disconnect();

    const capture = () => {
      const events = win.__pinnedRowStatusEvents;
      if (!events) return;
      const pinnedSection = document.querySelector('[data-testid="sidebar-pinned-section"]');
      if (!pinnedSection) return;
      const rows = pinnedSection.querySelectorAll<HTMLElement>(
        '[data-testid^="sidebar-workspace-row-"]',
      );
      for (const row of rows) {
        const rowTestId = row.getAttribute("data-testid");
        if (!rowTestId) continue;
        const badge = row.querySelector<HTMLElement>('[data-testid="project-status-badge"]');
        const hasStatusBadge = badge !== null;
        const statusLabel = badge?.getAttribute("aria-label") ?? null;
        const last = events.at(-1);
        if (
          last?.rowTestId === rowTestId &&
          last.hasStatusBadge === hasStatusBadge &&
          last.statusLabel === statusLabel
        ) {
          continue;
        }
        events.push({ rowTestId, hasStatusBadge, statusLabel, at: performance.now() });
      }
    };

    capture();
    const observer = new MutationObserver(capture);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-testid", "aria-label"],
    });
    win.__pinnedRowStatusObserver = observer;
  });
}

async function getTrackedPinnedRowStatusEvents(
  page: import("@playwright/test").Page,
): Promise<PinnedRowStatusEvent[]> {
  return page.evaluate(() => {
    const win = window as typeof window & {
      __pinnedRowStatusEvents?: PinnedRowStatusEvent[];
    };
    return win.__pinnedRowStatusEvents ?? [];
  });
}

async function waitForPinnedRowStatusBadge(input: {
  page: import("@playwright/test").Page;
  rowTestId: string;
}) {
  await input.page.waitForFunction(
    (expectedRowTestId) => {
      const win = window as typeof window & {
        __pinnedRowStatusEvents?: PinnedRowStatusEvent[];
      };
      for (const event of win.__pinnedRowStatusEvents ?? []) {
        if (event.rowTestId === expectedRowTestId && event.hasStatusBadge) return true;
      }
      return false;
    },
    input.rowTestId,
    { timeout: 30_000 },
  );
}

/**
 * Guards that a pinned row's status badge is never absent — absent is how "done"/idle reads on a
 * hoisted row, and that must never happen while its initial agent starts or runs.
 */
async function expectPinnedRowNeverLooksDone(input: {
  page: import("@playwright/test").Page;
  rowTestId: string;
}) {
  await waitForPinnedRowStatusBadge(input);
  const events = (await getTrackedPinnedRowStatusEvents(input.page)).filter(
    (event) => event.rowTestId === input.rowTestId,
  );
  expect(events.filter((event) => !event.hasStatusBadge)).toEqual([]);
}

/** Guards that a pinned row with no agent never shows a running/loading badge. */
async function expectPinnedRowNeverLooksRunning(input: {
  page: import("@playwright/test").Page;
  rowTestId: string;
}) {
  const events = (await getTrackedPinnedRowStatusEvents(input.page)).filter(
    (event) => event.rowTestId === input.rowTestId,
  );
  expect(events.filter((event) => event.hasStatusBadge)).toEqual([]);
}

async function fetchWorkspaceStatus(
  client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>,
  workspaceId: string,
): Promise<string | undefined> {
  const { entries } = await client.fetchWorkspaces();
  return entries.find((entry) => entry.id === workspaceId)?.status;
}

async function submitNewWorkspaceWithoutPrompt(page: import("@playwright/test").Page) {
  const createButton = page
    .getByTestId("message-input-root")
    .getByRole("button", { name: "Create" });
  await expect(createButton).toBeVisible({ timeout: 30_000 });
  await createButton.click();
}

test.describe("New workspace flow", () => {
  let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  const localWorkspaceIds = new Set<string>();
  const localProjectIds = new Set<string>();
  const createdWorktreeDirectories = new Set<string>();
  const localGithubFixtures = new Set<LocalGhPrFixture>();

  test.describe.configure({ timeout: 240_000 });

  test.beforeEach(async () => {
    client = await connectNewWorkspaceDaemonClient();
  });

  test.afterEach(async () => {
    if (client) {
      for (const workspaceDirectory of createdWorktreeDirectories) {
        await archiveWorkspaceFromDaemon(client, workspaceDirectory).catch(() => undefined);
      }
      for (const workspaceId of localWorkspaceIds) {
        await archiveLocalWorkspaceFromDaemon(client, workspaceId).catch(() => undefined);
      }
      for (const projectId of localProjectIds) {
        await client.removeProject(projectId).catch(() => undefined);
      }
    }
    createdWorktreeDirectories.clear();
    localWorkspaceIds.clear();
    localProjectIds.clear();
    await client?.close().catch(() => undefined);
  });

  test.afterAll(async () => {
    for (const fixture of localGithubFixtures) {
      await fixture.cleanup();
    }
    localGithubFixtures.clear();
  });

  test("adds a project from the selected empty host", async ({ page }) => {
    const repo = await createTempGitRepo("new-workspace-project-picker-");
    const primaryServerId = getServerId();
    const emptyServerId = "empty-new-workspace-host";

    try {
      const openedProject = await openProjectViaDaemon(client, repo.path);
      localWorkspaceIds.add(openedProject.workspaceId);
      await seedSavedSettingsHosts(page, [
        {
          serverId: primaryServerId,
          label: "Primary host",
          endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
        },
        {
          serverId: emptyServerId,
          label: "Empty host",
          endpoint: "127.0.0.1:9",
        },
      ]);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openGlobalNewWorkspaceComposer(page);

      const projectTrigger = page.getByTestId("new-workspace-project-picker-trigger");
      await projectTrigger.click();
      await page.getByPlaceholder("Search projects").fill("no matching project");
      await expect(page.getByTestId("new-workspace-project-picker-add-project")).toBeVisible();
      await page.keyboard.press("Escape");

      await page.getByTestId("host-picker-trigger").click();
      await page.getByTestId(`new-workspace-host-picker-option-${emptyServerId}`).click();
      await expect(projectTrigger).toContainText("Choose project");
      await projectTrigger.click();

      const addProject = page.getByTestId("new-workspace-project-picker-add-project");
      await expect(addProject).toContainText("Add project");
      await expect(addProject).toContainText(/(?:⌘|Ctrl\+)O/);
      await addProject.click();

      await expectAddProjectPage(page, "method");
      await chooseAddProjectMethod(page, "directory-search");
    } finally {
      await repo.cleanup();
    }
  });

  test("sidebar workspace navigation updates URL and header", async ({ page }) => {
    const serverId = getServerId();

    const firstRepo = await createTempGitRepo("workspace-nav-a-");
    const secondRepo = await createTempGitRepo("workspace-nav-b-");

    try {
      const firstWorkspace = await openProjectViaDaemon(client, firstRepo.path);
      const secondWorkspace = await openProjectViaDaemon(client, secondRepo.path);
      localWorkspaceIds.add(firstWorkspace.workspaceId);
      localWorkspaceIds.add(secondWorkspace.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: firstWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: firstWorkspace.workspaceName,
        subtitle: firstWorkspace.projectDisplayName,
      });

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: secondWorkspace.workspaceId,
      });
      await waitForWorkspaceInSidebar(page, {
        serverId,
        workspaceId: secondWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: secondWorkspace.workspaceName,
        subtitle: secondWorkspace.projectDisplayName,
      });

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: firstWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: firstWorkspace.workspaceName,
        subtitle: firstWorkspace.projectDisplayName,
      });
    } finally {
      await secondRepo.cleanup();
      await firstRepo.cleanup();
    }
  });

  test("same-project workspaces switch content without requiring refresh", async ({ page }) => {
    const serverId = getServerId();

    const repo = await createTempGitRepo("workspace-nav-same-project-");

    try {
      const rootWorkspace = await openProjectViaDaemon(client, repo.path);
      const worktreeWorkspace = await createWorktreeViaDaemon(client, {
        cwd: repo.path,
        slug: `nav-${Date.now()}`,
      });
      localWorkspaceIds.add(rootWorkspace.workspaceId);
      createdWorktreeDirectories.add(worktreeWorkspace.workspaceDirectory);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: rootWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: rootWorkspace.workspaceName,
        subtitle: rootWorkspace.projectDisplayName,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: rootWorkspace.workspaceId,
      });

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: worktreeWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: worktreeWorkspace.workspaceName,
        subtitle: worktreeWorkspace.projectDisplayName,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: worktreeWorkspace.workspaceId,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: rootWorkspace.workspaceId,
        selected: false,
      });

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: rootWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: rootWorkspace.workspaceName,
        subtitle: rootWorkspace.projectDisplayName,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: rootWorkspace.workspaceId,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: worktreeWorkspace.workspaceId,
        selected: false,
      });
    } finally {
      await repo.cleanup();
    }
  });

  test("global new workspace uses the last active project and creates one agent tab", async ({
    page,
  }) => {
    const serverId = getServerId();

    const tempRepo = await createTempGitRepo("new-workspace-");

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: openedProject.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: openedProject.workspaceName,
        subtitle: openedProject.projectDisplayName,
      });

      await openGlobalNewWorkspaceComposer(page);
      await expectNewWorkspaceProjectSelected(page, openedProject.projectDisplayName);
      await submitNewWorkspacePrompt(page);

      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
        assertSidebarRow: false,
        assertHeader: false,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      expect(createdWorkspace.workspaceId).not.toBe(openedProject.workspaceId);
      await expect(page).toHaveURL(
        buildHostWorkspaceRoute(serverId, createdWorkspace.workspaceId),
        {
          timeout: 30_000,
        },
      );

      const createdWorkspaceRow = page.getByTestId(
        `sidebar-workspace-row-${serverId}:${createdWorkspace.workspaceId}`,
      );
      await expect(createdWorkspaceRow).toBeVisible({ timeout: 30_000 });

      await expectWorkspaceHeader(page, {
        title: createdWorkspace.workspaceName,
        subtitle: openedProject.projectDisplayName,
      });

      const activeWorkspaceDeckEntry = page
        .getByTestId(`workspace-deck-entry-${serverId}:${createdWorkspace.workspaceId}`)
        .filter({ visible: true });
      await expect(activeWorkspaceDeckEntry).toBeVisible({ timeout: 30_000 });

      const agentTabs = activeWorkspaceDeckEntry.locator('[data-testid^="workspace-tab-agent_"]');
      await expect(agentTabs).toHaveCount(1, { timeout: 30_000 });

      // Workspace setup may auto-open a setup tab that steals focus,
      // hiding the agent panel (display:none removes it from the
      // accessibility tree). Click the agent tab to ensure it's active.
      await agentTabs.first().click();

      const composer = page.getByRole("textbox", { name: "Message agent..." });
      await expect(composer).toBeVisible({ timeout: 30_000 });
    } finally {
      await tempRepo.cleanup();
    }
  });

  test("redirects to the optimistic draft tab before agent creation resolves", async ({ page }) => {
    const serverId = getServerId();

    const tempRepo = await createTempGitRepo("new-workspace-optimistic-");
    const agentCreatedDelay = await delayBrowserAgentCreatedStatus(page);

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: openedProject.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: openedProject.workspaceName,
        subtitle: openedProject.projectDisplayName,
      });

      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });

      const composer = page.getByRole("textbox", { name: "Message agent..." });
      await expect(composer).toBeVisible({ timeout: 30_000 });
      await composer.fill("Hello from e2e");

      const createButton = page
        .getByTestId("message-input-root")
        .getByRole("button", { name: "Create" });
      await expect(createButton).toBeVisible({ timeout: 30_000 });
      await createButton.click();

      await agentCreatedDelay.waitForCreateRequest();
      await agentCreatedDelay.waitForDelayedCreatedStatus();

      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
        assertSidebarRow: false,
        assertHeader: false,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      await expect(page).toHaveURL(
        buildHostWorkspaceRoute(serverId, createdWorkspace.workspaceId),
        {
          timeout: 30_000,
        },
      );

      const activeWorkspaceDeckEntry = page
        .getByTestId(`workspace-deck-entry-${serverId}:${createdWorkspace.workspaceId}`)
        .filter({ visible: true });
      await expect(activeWorkspaceDeckEntry).toBeVisible({ timeout: 30_000 });

      const draftTabs = activeWorkspaceDeckEntry.locator('[data-testid^="workspace-tab-draft_"]');
      await expect(draftTabs).toHaveCount(1, { timeout: 30_000 });
      await expect(
        activeWorkspaceDeckEntry.locator('[data-testid^="workspace-tab-agent_"]'),
      ).toHaveCount(0);

      agentCreatedDelay.release();
      await expect(
        activeWorkspaceDeckEntry.locator('[data-testid^="workspace-tab-agent_"]'),
      ).toHaveCount(1, { timeout: 30_000 });
    } finally {
      agentCreatedDelay.release();
      await tempRepo.cleanup();
    }
  });

  test("new workspace with initial agent lands in Pinned and never looks done while it starts", async ({
    page,
  }) => {
    const serverId = getServerId();

    const tempRepo = await createTempGitRepo("new-workspace-status-optimistic-");

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: openedProject.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: openedProject.workspaceName,
        subtitle: openedProject.projectDisplayName,
      });

      await startTrackingPinnedRowStatus(page);

      await openGlobalNewWorkspaceComposer(page);
      await expectNewWorkspaceProjectSelected(page, openedProject.projectDisplayName);
      await submitNewWorkspacePrompt(page);

      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
        assertSidebarRow: false,
        assertHeader: false,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      const rowTestId = `sidebar-workspace-row-${serverId}:${createdWorkspace.workspaceId}`;
      // A session start auto-pins the new workspace (workspace-auto-pin.ts), so it lands in
      // Pinned rather than a status group.
      await expect(page.getByTestId("sidebar-pinned-section").getByTestId(rowTestId)).toBeVisible({
        timeout: 30_000,
      });
      await expectPinnedRowNeverLooksDone({ page, rowTestId });
    } finally {
      await tempRepo.cleanup();
    }
  });

  test("new workspace without an initial agent lands in Pinned and never looks running", async ({
    page,
  }) => {
    const serverId = getServerId();

    const tempRepo = await createTempGitRepo("new-workspace-status-empty-");

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: openedProject.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: openedProject.workspaceName,
        subtitle: openedProject.projectDisplayName,
      });

      await startTrackingPinnedRowStatus(page);

      await openGlobalNewWorkspaceComposer(page);
      await expectNewWorkspaceProjectSelected(page, openedProject.projectDisplayName);
      await submitNewWorkspaceWithoutPrompt(page);

      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      const rowTestId = `sidebar-workspace-row-${serverId}:${createdWorkspace.workspaceId}`;
      // A session start auto-pins the new workspace (workspace-auto-pin.ts), so it lands in
      // Pinned rather than a status group.
      await expect(page.getByTestId("sidebar-pinned-section").getByTestId(rowTestId)).toBeVisible({
        timeout: 30_000,
      });
      await expect
        .poll(() => fetchWorkspaceStatus(client, createdWorkspace.workspaceId), {
          timeout: 30_000,
        })
        .toBe("done");
      await expect(
        page.getByTestId(rowTestId).locator('[data-testid="workspace-status-indicator-loading"]'),
      ).toHaveCount(0);
      await expectPinnedRowNeverLooksRunning({ page, rowTestId });
    } finally {
      await tempRepo.cleanup();
    }
  });

  test("selected branch becomes the base of a new workspace worktree", async ({ page }) => {
    const serverId = getServerId();

    const tempRepo = await createTempGitRepo("new-workspace-ref-", {
      branches: ["main", "dev"],
    });

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: openedProject.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: openedProject.workspaceName,
        subtitle: openedProject.projectDisplayName,
      });

      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await selectWorkspaceIsolation(page, "worktree");
      await openStartingRefPicker(page);
      await selectBranchInPicker(page, "dev");

      const createButton = page
        .getByTestId("message-input-root")
        .getByRole("button", { name: "Create" });
      await expect(createButton).toBeVisible({ timeout: 30_000 });
      await createButton.click();

      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      expect(existsSync(createdWorkspace.workspaceDirectory)).toBe(true);

      const branchInfo = await readWorktreeBranchInfo({
        worktreePath: createdWorkspace.workspaceDirectory,
      });
      expect(branchInfo.currentBranch).toBe(path.basename(createdWorkspace.workspaceDirectory));
      expect(branchInfo.hasAncestor(tempRepo.branchHeads.main)).toBe(true);
      expect(branchInfo.hasAncestor(tempRepo.branchHeads.dev)).toBe(true);
    } finally {
      await tempRepo.cleanup();
    }
  });

  // The starting ref the daemon actually cuts from is the thing that broke: the picker said
  // one ref and the worktree was created from another. Every assertion here reads the
  // created worktree's commits or its recorded base, never the trigger text alone.
  test.describe("default starting ref", () => {
    async function openWorktreeComposerForRepo(
      page: import("@playwright/test").Page,
      repoPath: string,
    ) {
      const openedProject = await openProjectViaDaemon(client, repoPath);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await selectWorkspaceIsolation(page, "worktree");
      return openedProject;
    }

    async function createWorktreeAndRead(
      page: import("@playwright/test").Page,
      openedProject: Awaited<ReturnType<typeof openProjectViaDaemon>>,
    ) {
      await submitNewWorkspaceEmpty(page);
      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId: getServerId(),
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);
      return {
        ...createdWorkspace,
        branchInfo: await readWorktreeBranchInfo({
          worktreePath: createdWorkspace.workspaceDirectory,
        }),
      };
    }

    test("branches off the upstream when the local branch is ahead and the picker is untouched", async ({
      page,
    }) => {
      const tempRepo = await createTempGitRepo("ref-default-ahead-", { withRemote: true });

      try {
        const originHead = readRepoRef(tempRepo.path, "refs/remotes/origin/main");
        commitLocalOnly(tempRepo.path, "one");
        const localHead = commitLocalOnly(tempRepo.path, "two");

        const openedProject = await openWorktreeComposerForRepo(page, tempRepo.path);
        const created = await createWorktreeAndRead(page, openedProject);

        expect(created.branchInfo.hasAncestor(originHead)).toBe(true);
        expect(created.branchInfo.hasAncestor(localHead)).toBe(false);
      } finally {
        await tempRepo.cleanup();
      }
    });

    test("branches off the local ref when the local row is chosen explicitly", async ({
      page,
    }, testInfo) => {
      const tempRepo = await createTempGitRepo("ref-default-local-pick-", { withRemote: true });

      try {
        commitLocalOnly(tempRepo.path, "one");
        const localHead = commitLocalOnly(tempRepo.path, "two");

        const openedProject = await openWorktreeComposerForRepo(page, tempRepo.path);

        await openStartingRefPicker(page);
        await expectStartingRefRows(page, [
          "main, origin branch",
          "main, local branch, 2 commits ahead of origin main",
        ]);
        const screenshotPath = testInfo.outputPath("ref-picker-local-ahead.png");
        await captureStartingRefPicker(page, screenshotPath);
        await testInfo.attach("Ref picker: local ahead of upstream", {
          path: screenshotPath,
          contentType: "image/png",
        });
        await startingRefRow(page, "main, local branch, 2 commits ahead of origin main").click();
        await expectPickerSelected(page, "main (local)");

        const created = await createWorktreeAndRead(page, openedProject);
        expect(created.branchInfo.hasAncestor(localHead)).toBe(true);
      } finally {
        await tempRepo.cleanup();
      }
    });

    test("branches off a fork's upstream remote and records the branch name", async ({
      page,
    }, testInfo) => {
      const tempRepo = await createTempGitRepo("ref-default-fork-", { withRemote: true });

      try {
        const upstreamHead = await trackForkUpstream(tempRepo.path);
        const originHead = readRepoRef(tempRepo.path, "refs/remotes/origin/main");

        const openedProject = await openWorktreeComposerForRepo(page, tempRepo.path);

        await openStartingRefPicker(page);
        // Branch suggestions only know about origin, so the upstream the fork actually
        // tracks gets its own row rather than silently sharing origin's. Two rows reading
        // "main" is the ambiguity this whole change exists to remove.
        await expectStartingRefRows(page, [
          "main (upstream), upstream branch",
          "main, origin branch",
        ]);
        await expectPickerSelected(page, "main (upstream)");
        const screenshotPath = testInfo.outputPath("ref-picker-fork.png");
        await captureStartingRefPicker(page, screenshotPath);
        await testInfo.attach("Ref picker: fork tracking upstream/main", {
          path: screenshotPath,
          contentType: "image/png",
        });
        await closeBranchPicker(page);

        const created = await createWorktreeAndRead(page, openedProject);

        expect(created.branchInfo.hasAncestor(upstreamHead)).toBe(true);
        expect(upstreamHead).not.toBe(originHead);
        // The name is what the UI shows; the ref is what resolves back to this commit.
        expect(await readWorktreeBaseMetadata(created.workspaceDirectory)).toEqual({
          baseRefName: "main",
          baseRef: "refs/remotes/upstream/main",
        });
      } finally {
        await tempRepo.cleanup();
      }
    });
  });

  test("branch picker opens via keyboard and selects the filtered option on Enter", async ({
    page,
  }) => {
    const tempRepo = await createTempGitRepo("picker-keyboard-", { branches: ["main", "dev"] });

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await selectWorkspaceIsolation(page, "worktree");

      await openBranchPicker(page);
      await expectPickerOpen(page);
      await selectPickerOptionByKeyboard(page, "dev");
      await expectPickerSelected(page, "dev");
      await expectPickerClosed(page);
    } finally {
      await tempRepo.cleanup();
    }
  });

  test("branch picker closes on Escape without selecting an option", async ({ page }) => {
    const tempRepo = await createTempGitRepo("picker-escape-");

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await selectWorkspaceIsolation(page, "worktree");

      await openBranchPicker(page);
      await expectPickerOpen(page);
      await closeBranchPicker(page);
      await expectPickerClosed(page);
    } finally {
      await tempRepo.cleanup();
    }
  });

  test("selected GitHub PR shows PR context in the trigger and composer", async ({ page }) => {
    test.skip(!hasGithubAuth(), "Requires GitHub authentication (gh auth login)");

    const ghRepo = await createTempGithubRepo({
      category: "new-workspace-pr-ref",
      prs: [{ title: "Review selected start ref", state: "open" }],
    });
    const pr = ghRepo.prs[0]!;

    try {
      const openedProject = await openProjectViaDaemon(client, pr.localPath);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await selectWorkspaceIsolation(page, "worktree");
      await openStartingRefPicker(page);
      await selectGitHubPrInPicker(page, pr.number);

      await expectStartingRefPickerTriggerPr(page, {
        number: pr.number,
        title: pr.title,
        headRef: pr.branch,
      });
      await expectComposerGithubAttachmentPill(page, {
        number: pr.number,
        title: pr.title,
      });
    } finally {
      await ghRepo.cleanup();
    }
  });

  test("pasted GitHub PR replaces a selected branch and creates its worktree", async ({
    page,
    context,
  }) => {
    const fixture = await createLocalGithubPrFixture();
    localGithubFixtures.add(fixture);
    const { pr, mainCheckout } = fixture;

    const openedProject = await openProjectViaDaemon(client, mainCheckout.path);
    localWorkspaceIds.add(openedProject.workspaceId);
    localProjectIds.add(openedProject.projectId);

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, {
      projectKey: openedProject.projectKey,
      projectDisplayName: openedProject.projectDisplayName,
    });
    await selectWorkspaceIsolation(page, "worktree");
    await openStartingRefPicker(page);
    await selectBranchInPicker(page, "main");

    await pasteGithubPrUrl(page, context, pr.url);

    const createButton = page.getByTestId("workspace-create-submit");
    await expect(createButton).toBeDisabled();
    await expect(createButton.getByRole("progressbar")).toHaveCount(0);

    await dropFileOnComposer(page, BACKGROUND_RESOLUTION_FILE);
    await expectAttachmentPill(page, "composer-file-attachment-pill");

    await expectComposerGithubAttachmentPill(page, {
      number: pr.number,
      title: pr.title,
    });
    await expectStartingRefPickerTriggerPr(page, {
      number: pr.number,
      title: pr.title,
      headRef: pr.branch,
    });

    await submitNewWorkspaceWithoutPrompt(page);

    const worktree = await assertNewWorkspaceSidebarAndHeader(page, {
      serverId: getServerId(),
      client,
      previousWorkspaceId: openedProject.workspaceId,
      projectDisplayName: openedProject.projectDisplayName,
    });
    createdWorktreeDirectories.add(worktree.workspaceDirectory);

    const branchInfo = await readWorktreeBranchInfo({
      worktreePath: worktree.workspaceDirectory,
    });
    expect(branchInfo.currentBranch).toBe(pr.branch);
    expect(existsSync(path.join(worktree.workspaceDirectory, "pr-1.txt"))).toBe(true);
  });

  test("branches remain searchable after a pasted PR and determine the created worktree", async ({
    page,
    context,
  }) => {
    const fixture = await createLocalGithubPrFixture();
    localGithubFixtures.add(fixture);
    const { pr, mainCheckout } = fixture;

    const openedProject = await openProjectViaDaemon(client, mainCheckout.path);
    localWorkspaceIds.add(openedProject.workspaceId);
    localProjectIds.add(openedProject.projectId);

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, {
      projectKey: openedProject.projectKey,
      projectDisplayName: openedProject.projectDisplayName,
    });
    await selectWorkspaceIsolation(page, "worktree");
    await pasteGithubPrUrl(page, context, pr.url);
    await expectStartingRefPickerTriggerPr(page, {
      number: pr.number,
      title: pr.title,
      headRef: pr.branch,
    });

    await openStartingRefPicker(page);
    await searchAndSelectBranchInPicker(page, "main");
    await expectPickerSelected(page, "main");
    await fillNewWorkspaceDraft(page, `${pr.url}\nKeep this checkout on main`);
    await expectPickerSelected(page, "main");
    await submitNewWorkspaceWithoutPrompt(page);

    const worktree = await assertNewWorkspaceSidebarAndHeader(page, {
      serverId: getServerId(),
      client,
      previousWorkspaceId: openedProject.workspaceId,
      projectDisplayName: openedProject.projectDisplayName,
    });
    createdWorktreeDirectories.add(worktree.workspaceDirectory);

    expect(existsSync(path.join(worktree.workspaceDirectory, "pr-1.txt"))).toBe(false);
  });

  test("selected GitHub PR creates the worktree from the PR head even when the head branch is not fetched", async ({
    page,
  }) => {
    test.skip(!hasGithubAuth(), "Requires GitHub authentication (gh auth login)");

    const ghRepo = await createTempGithubRepo({
      category: "new-workspace-pr-worktree",
      prs: [{ title: "Checkout PR worktree", state: "open" }],
    });
    const pr = ghRepo.prs[0]!;
    const mainCheckout = await cloneGithubRepoDefaultBranchOnly(ghRepo);

    try {
      const openedProject = await openProjectViaDaemon(client, mainCheckout.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await selectWorkspaceIsolation(page, "worktree");
      await openStartingRefPicker(page);
      await selectGitHubPrInPicker(page, pr.number);
      await submitNewWorkspaceWithoutPrompt(page);

      const worktree = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId: getServerId(),
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
      });
      createdWorktreeDirectories.add(worktree.workspaceDirectory);

      const branchInfo = await readWorktreeBranchInfo({
        worktreePath: worktree.workspaceDirectory,
      });
      expect(branchInfo.currentBranch).toBe(pr.branch);
      expect(existsSync(path.join(worktree.workspaceDirectory, "pr-1.txt"))).toBe(true);
    } finally {
      await mainCheckout.cleanup();
      await ghRepo.cleanup();
    }
  });
});
