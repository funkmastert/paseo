import path from "node:path";
import { test, expect, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace, settleAutoPin } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { selectSidebarStatusGrouping } from "../support/helpers/sidebar";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";

// Inline rename of a workspace ("session") name, in the real app against the e2e daemon: the
// second click on the active sidebar row in every grouping, and a tap on the header title. The
// screenshots are the review's UI evidence; they land in the git-ignored .artifacts directory.
const ARTIFACTS = path.resolve(__dirname, "../../.artifacts/session-titles");
// Longer than the hook's double-click window, so a click reads as a deliberate second click.
const SETTLE_MS = 700;

function rowTestId(workspaceId: string): string {
  return `sidebar-workspace-row-${getServerId()}:${workspaceId}`;
}

function row(page: Page, workspaceId: string) {
  return page.getByTestId(rowTestId(workspaceId));
}

function rowInput(page: Page, workspaceId: string) {
  return page.getByTestId(`${rowTestId(workspaceId)}-title-input`);
}

async function openFromSidebar(page: Page, workspaceId: string): Promise<void> {
  await expect(row(page, workspaceId)).toBeVisible({ timeout: 30_000 });
  await row(page, workspaceId).click();
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
}

async function renameFromRow(page: Page, workspaceId: string, name: string, shot?: string) {
  await page.waitForTimeout(SETTLE_MS);
  await row(page, workspaceId).click();
  const input = rowInput(page, workspaceId);
  await expect(input).toBeVisible({ timeout: 10_000 });
  await expect(input).toBeFocused();
  if (shot) {
    await input.fill(name);
    await page.screenshot({ path: path.join(ARTIFACTS, shot) });
  } else {
    await input.fill(name);
  }
  await input.press("Enter");
  await expect(input).toHaveCount(0);
  await expect(row(page, workspaceId)).toContainText(name, { timeout: 15_000 });
}

test.describe("Workspace inline rename (desktop)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("second click on the active row edits it in project grouping", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "inline-rename-project-" });
    try {
      await gotoAppShell(page);
      await openFromSidebar(page, workspace.workspaceId);
      await renameFromRow(
        page,
        workspace.workspaceId,
        "Payments flow",
        "desktop-sidebar-row-edit-project-grouping.png",
      );
      await expect(page.getByTestId("workspace-header-title")).toContainText("Payments flow");
    } finally {
      await workspace.cleanup();
    }
  });

  test("second click on the active row edits it in status grouping", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "inline-rename-status-" });
    try {
      await settleAutoPin(workspace.client, workspace.workspaceId);
      await gotoAppShell(page);
      await openFromSidebar(page, workspace.workspaceId);
      await selectSidebarStatusGrouping(page);
      await expect(page.getByTestId("sidebar-status-list-scroll")).toBeVisible({
        timeout: 10_000,
      });
      await renameFromRow(
        page,
        workspace.workspaceId,
        "Status grouped name",
        "desktop-sidebar-row-edit-status-grouping.png",
      );
    } finally {
      await workspace.cleanup();
    }
  });

  test("second click on a pinned row edits it in status grouping", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "inline-rename-pinned-" });
    try {
      await workspace.client.setWorkspacePinned(workspace.workspaceId, true);
      await gotoAppShell(page);
      await selectSidebarStatusGrouping(page);
      const pinned = page.getByTestId("sidebar-pinned-section");
      await expect(pinned.getByTestId(rowTestId(workspace.workspaceId))).toBeVisible({
        timeout: 30_000,
      });
      await openFromSidebar(page, workspace.workspaceId);
      await renameFromRow(page, workspace.workspaceId, "Pinned name");
      await expect(pinned).toContainText("Pinned name");
    } finally {
      await workspace.cleanup();
    }
  });

  test("double-clicking a row to open it never enters edit", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "inline-rename-dblclick-" });
    try {
      await gotoAppShell(page);
      await expect(row(page, workspace.workspaceId)).toBeVisible({ timeout: 30_000 });
      await row(page, workspace.workspaceId).dblclick();
      await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
      await page.waitForTimeout(SETTLE_MS);
      await expect(rowInput(page, workspace.workspaceId)).toHaveCount(0);
    } finally {
      await workspace.cleanup();
    }
  });

  test("tapping the header title edits it, and Escape keeps the old name", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "inline-rename-header-" });
    try {
      await gotoAppShell(page);
      await openFromSidebar(page, workspace.workspaceId);
      const title = page.getByTestId("workspace-header-title");
      await expect(title).toBeVisible({ timeout: 30_000 });
      const before = (await title.textContent()) ?? "";

      await title.click();
      const input = page.getByTestId("workspace-header-title-input");
      await expect(input).toBeFocused();
      await input.fill("Header typed name");
      await page.screenshot({ path: path.join(ARTIFACTS, "desktop-header-edit.png") });
      await input.press("Escape");
      await expect(input).toHaveCount(0);
      await expect(title).toHaveText(before);

      await title.click();
      await page.getByTestId("workspace-header-title-input").fill("Header saved name");
      await page.getByTestId("workspace-header-title-input").press("Enter");
      await expect(title).toHaveText("Header saved name", { timeout: 15_000 });
      await expect(row(page, workspace.workspaceId)).toContainText("Header saved name");
    } finally {
      await workspace.cleanup();
    }
  });
});

test.describe("Workspace inline rename (phone)", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("tapping the header title edits it", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "inline-rename-phone-" });
    try {
      await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.workspaceId));
      const title = page.getByTestId("workspace-header-title");
      await expect(title).toBeVisible({ timeout: 30_000 });
      await title.tap();
      const input = page.getByTestId("workspace-header-title-input");
      await expect(input).toBeFocused();
      await input.fill("Phone name");
      await page.screenshot({ path: path.join(ARTIFACTS, "phone-header-edit.png") });
      await input.press("Enter");
      await expect(title).toHaveText("Phone name", { timeout: 15_000 });
    } finally {
      await workspace.cleanup();
    }
  });
});
