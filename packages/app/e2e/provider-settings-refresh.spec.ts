import { expect, test, type Page } from "./fixtures";
import { expectComposerVisible } from "./helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "./helpers/mock-agent";

const MOBILE_VIEWPORT = { width: 390, height: 844 };

async function openMockAgentAtMobileBreakpoint(page: Page) {
  await page.setViewportSize(MOBILE_VIEWPORT);
  const session = await seedMockAgentWorkspace({
    repoPrefix: "provider-sheet-stack-",
    title: "Provider sheet stack e2e",
  });
  await openAgentRoute(page, session);
  await expectComposerVisible(page);
  await expect(page.getByRole("button", { name: /Select model/ })).toBeVisible({
    timeout: 30_000,
  });
  return session;
}

// At the mobile-web breakpoint our fork renders the model selector (a shared
// `Combobox`) through an RN `Modal` "web-modal" body, NOT @gorhom/bottom-sheet —
// see PR #35 and src/components/ui/combobox-presentation.ts. So the upstream
// gorhom-only selectors ("Bottom Sheet" label, "Bottom sheet handle" slider)
// never exist for the model selector on web; it renders
// testID="combobox-mobile-web-container" with a "Dismiss" backdrop button. The
// provider sub-sheets reached from inside it (provider-settings-sheet,
// add-custom-model-sheet, provider-diagnostic-sheet) are AdaptiveModalSheet
// instances and keep their testID/"Close"-button contract.
async function openProviderSettingsFromModelSelector(page: Page) {
  await page.getByRole("button", { name: /Select model/ }).click();
  await expect(page.getByTestId("combobox-mobile-web-container")).toBeVisible({ timeout: 10_000 });

  const openCodeRow = page.getByText("OpenCode", { exact: true }).first();
  if (await openCodeRow.isVisible().catch(() => false)) {
    await openCodeRow.click();
  }

  await page.getByRole("button", { name: /Open .* settings/ }).click();
  await expect(page.getByTestId("provider-settings-sheet")).toBeVisible({ timeout: 10_000 });
}

async function expectModelSelectorVisible(page: Page) {
  await expect(page.getByRole("button", { name: /Open .* settings/ })).toBeVisible({
    timeout: 10_000,
  });
}

async function closeTopSheet(page: Page) {
  const closeTarget = page.getByLabel("Close", { exact: true }).last();
  if (await closeTarget.isVisible().catch(() => false)) {
    await closeTarget.click({ force: true });
    return;
  }

  // The top sheet here is the model selector, which on web-mobile is the
  // "web-modal" combobox container (no "Close" button, no gorhom handle). Close
  // it by clicking its "Dismiss" backdrop. The backdrop is a Pressable with
  // accessibilityLabel="Dismiss" and no role, so it is matched by label, not by
  // getByRole("button", …).
  const container = page.getByTestId("combobox-mobile-web-container").first();
  const backdrop = page.getByLabel("Dismiss", { exact: true }).first();
  if (await backdrop.isVisible().catch(() => false)) {
    await backdrop.click({ force: true });
    await expect(container).not.toBeVisible({ timeout: 10_000 });
    return;
  }
  throw new Error("Top sheet had neither a Close button nor a web-modal Dismiss backdrop");
}

async function closeSheetByHeaderButton(page: Page, testId: string) {
  const sheet = page.getByTestId(testId);
  await sheet.getByLabel("Close", { exact: true }).click({ force: true });
  await expect(sheet).not.toBeVisible({ timeout: 10_000 });
}

async function expectProviderSettingsVisible(page: Page) {
  await expect(page.getByTestId("provider-settings-sheet")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Add model" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Diagnostic", exact: true })).toBeVisible();
}

async function exerciseProviderSettingsStack(page: Page) {
  await expectProviderSettingsVisible(page);

  await page.getByRole("button", { name: "Add model" }).click();
  await expect(page.getByTestId("add-custom-model-sheet")).toBeVisible({ timeout: 10_000 });
  await closeSheetByHeaderButton(page, "add-custom-model-sheet");
  await expect(page.getByPlaceholder("e.g. openai/gpt-5")).not.toBeVisible({ timeout: 10_000 });
  await expectProviderSettingsVisible(page);

  await page.getByRole("button", { name: "Diagnostic", exact: true }).click();
  await expect(page.getByTestId("provider-diagnostic-sheet")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /Refresh diagnostic/ }).click();
  await expect(page.getByTestId("provider-diagnostic-sheet")).toBeVisible({ timeout: 10_000 });
  await closeSheetByHeaderButton(page, "provider-diagnostic-sheet");
  await expectProviderSettingsVisible(page);

  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expectProviderSettingsVisible(page);
}

test.describe("provider settings bottom-sheet stack", () => {
  test("provider settings and children close back through the model selector stack", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    // BOUNDARY (upstream-0.1.99 merge): this flow is not reachable on web-mobile
    // in our fork by deliberate design, so the test is marked fixme rather than
    // adapted to a fake pass. Detail:
    //
    //   The provider-settings sheet stack is entered from the model selector via
    //   the "Open <provider> settings" button. That button is rendered ONLY in
    //   the Combobox `header` actions (combined-model-selector.tsx sheetHeader,
    //   testID `selector-header-settings-<provider>`), and only while the
    //   selector is in a `view.kind === "provider"` view.
    //
    //   At the mobile-web breakpoint our fork renders the model selector through
    //   the RN-`Modal` "web-modal" body (WebMobileComboboxBody — the deliberate
    //   PR #35 fix, because @gorhom/bottom-sheet does not present/reopen reliably
    //   on react-native-web). That body renders `title` + children (the model
    //   rows) but intentionally does NOT render the Combobox `header`. So the
    //   "Open <provider> settings" button — the sole entry point to
    //   provider-settings-sheet — is never in the DOM on web-mobile, and there is
    //   no in-body settings affordance in SelectorContent (it renders only the
    //   flat model list for the provider). Verified via the failing page snapshot
    //   (open dialog shows title "Select" + model rows only, no settings button)
    //   and by reading combobox.tsx WebMobileComboboxBody + combined-model-selector.tsx.
    //
    //   The provider sub-sheets themselves DO present on web-mobile — a throwaway
    //   probe opened the composer attachment menu (also an AdaptiveModalSheet /
    //   gorhom IsolatedBottomSheetModal at the compact breakpoint) at 390x844 in
    //   Chromium and it presented fine — so this is NOT a sub-sheet open/close/
    //   reopen app bug (boundary #4's "REAL app bug"). It is purely that the
    //   web-modal model selector has no provider-settings entry point on web-mobile.
    //
    //   Re-enabling requires an app-source change (out of scope for this test-only
    //   task): either WebMobileComboboxBody renders the Combobox `header` actions,
    //   or the model selector exposes a provider-settings affordance in its body
    //   on web-mobile. Until then the steps below cannot run on web-mobile. The
    //   body is kept intact (and already retargeted to the web-modal container /
    //   "Dismiss" backdrop) so it is ready to re-enable once an entry point exists.
    test.fixme();

    const session = await openMockAgentAtMobileBreakpoint(page);

    try {
      await openProviderSettingsFromModelSelector(page);
      await exerciseProviderSettingsStack(page);
      await closeSheetByHeaderButton(page, "provider-settings-sheet");

      await expectModelSelectorVisible(page);
      await page.getByRole("button", { name: /Open .* settings/ }).click();
      await expect(page.getByTestId("provider-settings-sheet")).toBeVisible({ timeout: 10_000 });
      await exerciseProviderSettingsStack(page);
      await closeSheetByHeaderButton(page, "provider-settings-sheet");

      await expectModelSelectorVisible(page);
      await closeTopSheet(page);
    } finally {
      await session.cleanup();
    }
  });
});
