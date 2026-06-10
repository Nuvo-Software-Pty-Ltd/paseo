import { expect, test } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import {
  archiveLocalWorkspaceFromDaemon,
  connectNewWorkspaceDaemonClient,
  openNewWorkspaceComposer,
  openProjectViaDaemon,
  openStartingRefPicker,
} from "./helpers/new-workspace";
import { createTempGitRepo } from "./helpers/workspace";
import { waitForSidebarHydration } from "./helpers/workspace-ui";

// Regression coverage for the iOS-Safari / mobile-web combobox bug: on a COMPACT
// viewport the shared Combobox must render its options through the web Modal sheet
// (WebMobileComboboxBody, testID "combobox-mobile-web-container") rather than the
// @gorhom/bottom-sheet path, which does not present on react-native-web. Before the
// fix the tap flipped isOpen=true but no sheet appeared, so no option was selectable.
//
// This runs on chromium-mobile in CI. It exercises the same shared Combobox used by
// every compact picker (automation Provider/Working-directory, chat model selector,
// branch switcher); the branch picker is used here because it is reachable without an
// agent and its option rows carry stable testIDs.
test.describe("Combobox — compact web picker", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  const localWorkspaceIds = new Set<string>();

  test.beforeEach(async () => {
    client = await connectNewWorkspaceDaemonClient();
  });

  test.afterEach(async () => {
    if (client) {
      for (const workspaceId of localWorkspaceIds) {
        await archiveLocalWorkspaceFromDaemon(client, workspaceId).catch(() => undefined);
      }
    }
    localWorkspaceIds.clear();
    await client?.close().catch(() => undefined);
  });

  test("opens the picker in a web Modal sheet and selects an option on a phone viewport", async ({
    page,
  }) => {
    const tempRepo = await createTempGitRepo("compact-web-picker-", { branches: ["main", "dev"] });

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });

      await openStartingRefPicker(page);

      // The web Modal sheet (NOT the @gorhom bottom sheet) must present its options.
      const sheet = page.getByTestId("combobox-mobile-web-container");
      await expect(sheet).toBeVisible({ timeout: 30_000 });
      // The desktop popover must NOT be used on a compact viewport.
      await expect(page.getByTestId("combobox-desktop-container")).toHaveCount(0);

      const branchRow = page.getByTestId("new-workspace-ref-picker-branch-dev");
      await expect(branchRow).toBeVisible({ timeout: 30_000 });
      await branchRow.click();

      // Selecting closes the sheet and the trigger reflects the chosen branch.
      await expect(sheet).toBeHidden({ timeout: 30_000 });
      await expect(page.getByRole("button", { name: "Starting ref" })).toContainText("dev");
    } finally {
      await tempRepo.cleanup();
    }
  });
});
