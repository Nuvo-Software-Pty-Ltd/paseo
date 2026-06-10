// Decides which body the shared Combobox renders. Kept pure (no platform imports)
// so it stays unit-testable in the node vitest project.
//
// Why three bodies instead of compact-vs-wide:
//   @gorhom/bottom-sheet's BottomSheetModal does NOT reliably present on
//   react-native-web — on mobile Safari especially, present() is called (isOpen
//   flips true) but the sheet never appears, so every compact combobox looked
//   "dead" on the deployed web app. The fix is to only use the gorhom sheet on
//   native and render an RN Modal on web-compact (the same web-proven primitive
//   the desktop popover already uses). See combobox.tsx WebMobileComboboxBody.
export type ComboboxPresentation = "native-sheet" | "web-modal" | "desktop";

export function resolveComboboxPresentation(input: {
  /** True when the current breakpoint is compact (xs/sm) — i.e. phone-width. */
  isCompact: boolean;
  /** True when the JS runtime is React Native (iOS/Android), false on web. */
  isNativeRuntime: boolean;
}): ComboboxPresentation {
  if (input.isCompact) {
    return input.isNativeRuntime ? "native-sheet" : "web-modal";
  }
  return "desktop";
}
