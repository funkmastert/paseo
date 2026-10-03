import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

// An auto pin lasts while its workspace is active: an agent in it working, or a use in the last
// `agents.autoPinRecentUseMinutes`. A quarter-minute window keeps expiry inside a spec.
// See docs/done-janitor.md#manual-pin-vs-auto-pin.
test.use({ e2eDaemonConfig: { version: 1, agents: { autoPinRecentUseMinutes: 0.25 } } });

function workspaceRow(page: Page, workspaceId: string): Locator {
  return page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
}

function pinnedRow(page: Page, workspaceId: string): Locator {
  return page
    .getByTestId("sidebar-pinned-section")
    .locator(`[data-testid="sidebar-workspace-row-${getServerId()}:${workspaceId}"]`);
}

async function readPinnedAt(workspace: SeededWorkspace): Promise<string | null> {
  const workspaces = await workspace.client.fetchWorkspaces();
  const entry = workspaces.entries.find((item) => item.id === workspace.workspaceId);
  return entry?.pinnedAt ?? null;
}

test.describe("Sidebar auto-pin", () => {
  test.describe.configure({ timeout: 180_000 });

  test("a started session sits in Pinned until it is finished, then groups with its project", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "auto-pin-expiry-" });

    try {
      await workspace.client.createAgent({
        provider: "mock",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Auto-pin agent",
        modeId: "load-test",
        model: "e2e-fast-stream",
        initialPrompt: "hello",
      });

      await gotoAppShell(page);
      await expect(pinnedRow(page, workspace.workspaceId)).toBeVisible({ timeout: 30_000 });

      await expect
        .poll(() => readPinnedAt(workspace), { timeout: 90_000, intervals: [1_000] })
        .toBeNull();
      await expect(page.getByTestId("sidebar-pinned-section")).toHaveCount(0, { timeout: 15_000 });
      await expect(workspaceRow(page, workspace.workspaceId)).toBeVisible();
    } finally {
      await workspace.cleanup();
    }
  });

  test("a pin set by hand outlasts the recent-use window", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "auto-pin-manual-" });

    try {
      await workspace.client.setWorkspacePinned(workspace.workspaceId, true);

      await gotoAppShell(page);
      await expect(pinnedRow(page, workspace.workspaceId)).toBeVisible({ timeout: 30_000 });

      // Twice the window: an auto pin with no agent working would have expired by now.
      await page.waitForTimeout(30_000);
      expect(await readPinnedAt(workspace)).not.toBeNull();
      await expect(pinnedRow(page, workspace.workspaceId)).toBeVisible();
    } finally {
      await workspace.cleanup();
    }
  });
});
