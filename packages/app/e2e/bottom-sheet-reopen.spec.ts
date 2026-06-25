import { expect, test, type Page } from "./fixtures";
import { expectComposerVisible } from "./helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "./helpers/mock-agent";

const MOBILE_VIEWPORT = { width: 390, height: 844 };

async function openMockAgentAtMobileBreakpoint(page: Page) {
  await page.setViewportSize(MOBILE_VIEWPORT);
  const session = await seedMockAgentWorkspace({
    repoPrefix: "bottom-sheet-reopen-",
    title: "Bottom sheet reopen e2e",
    initialPrompt: "Prepare a bottom sheet reopen test agent.",
  });
  await openAgentRoute(page, session);
  await expect(page.getByTestId("workspace-tab-switcher-trigger")).toBeVisible({
    timeout: 30_000,
  });
  await expectComposerVisible(page);
  await expect(page.getByRole("button", { name: /Select model/ })).toBeVisible({
    timeout: 30_000,
  });
  return session;
}

async function withMobileMockAgent(page: Page, run: () => Promise<void>) {
  const session = await openMockAgentAtMobileBreakpoint(page);

  try {
    await run();
  } finally {
    await session.cleanup();
  }
}

// At the mobile-web breakpoint our fork renders comboboxes (both the model
// selector and the tab switcher are shared `Combobox` instances) through an RN
// `Modal` "web-modal" body, NOT @gorhom/bottom-sheet — see PR #35 and
// src/components/ui/combobox-presentation.ts (`resolveComboboxPresentation`
// returns "web-modal" for web-compact because gorhom does not present/reopen
// reliably on react-native-web). So the upstream gorhom-only selectors
// ("Bottom sheet backdrop" / "Bottom sheet handle" slider / "Bottom Sheet"
// label) never exist on web. The web-modal (WebMobileComboboxBody) instead
// renders testID="combobox-mobile-web-container" with a "Dismiss" backdrop
// button and a DECORATIVE (role-less) handle, so the close path is a backdrop
// click — there is no handle-drag close. The open→close→reopen→close sequence
// is still genuinely exercised against the web-modal container.
function webComboboxContainer(page: Page) {
  return page.getByTestId("combobox-mobile-web-container").first();
}

function webComboboxBackdrop(page: Page) {
  // The backdrop is a Pressable with accessibilityLabel="Dismiss" but no
  // accessibilityRole, so react-native-web renders it as a role-less element
  // (accessible name only). getByLabel matches the name regardless of role;
  // getByRole("button", …) would not.
  return page.getByLabel("Dismiss", { exact: true }).first();
}

async function expectBottomSheetOpen(page: Page) {
  await expect(webComboboxContainer(page)).toBeVisible({ timeout: 10_000 });
}

async function closeBottomSheetWithBackdrop(page: Page) {
  const container = webComboboxContainer(page);
  const backdrop = webComboboxBackdrop(page);
  // Clicking the "Dismiss" backdrop is the close path under test. Retry the
  // click until the container is gone — on a loaded runner the model-selector
  // body re-renders as its model list settles and an early click can land
  // before onPress is wired.
  await expect(async () => {
    if (!(await container.isVisible())) {
      return;
    }
    if (await backdrop.isVisible()) {
      await backdrop.click({ force: true });
    }
    await page.waitForTimeout(150);
    await expect(container).not.toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  // Guard against the regression where the sheet starts dismissing, then re-presents.
  await page.waitForTimeout(500);
  await expect(container).not.toBeVisible({ timeout: 1_000 });
}

async function openTabSwitcher(page: Page) {
  const trigger = page.getByRole("button", { name: /Switch tabs/ });
  await trigger.click();
  await expectBottomSheetOpen(page);
}

async function openModelSelector(page: Page) {
  await page.getByRole("button", { name: /Select model/ }).click();
  await expectBottomSheetOpen(page);
  await expect(
    webComboboxContainer(page).getByText("Ten second stream", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 10_000 });
}

async function openAndCloseTabSwitcherTwice(page: Page) {
  await openTabSwitcher(page);
  await closeBottomSheetWithBackdrop(page);
  await openTabSwitcher(page);
  await closeBottomSheetWithBackdrop(page);
}

async function openAndCloseModelSelectorTwice(page: Page) {
  await openModelSelector(page);
  await closeBottomSheetWithBackdrop(page);
  await openModelSelector(page);
  await closeBottomSheetWithBackdrop(page);
}

test.describe("mobile bottom sheet reopen", () => {
  test("tab switcher can open, close, reopen, and close again", async ({ page }) => {
    await withMobileMockAgent(page, async () => {
      await openAndCloseTabSwitcherTwice(page);
    });
  });

  test("model selector can open, close, reopen, and close again", async ({ page }) => {
    await withMobileMockAgent(page, async () => {
      await openAndCloseModelSelectorTwice(page);
    });
  });
});
