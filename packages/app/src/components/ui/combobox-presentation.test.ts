import { describe, expect, it } from "vitest";
import { resolveComboboxPresentation } from "./combobox-presentation";

describe("resolveComboboxPresentation", () => {
  it("uses the native gorhom bottom sheet on compact native (iOS/Android)", () => {
    expect(resolveComboboxPresentation({ isCompact: true, isNativeRuntime: true })).toBe(
      "native-sheet",
    );
  });

  it("uses an RN Modal on compact web (mobile Safari) instead of the gorhom sheet", () => {
    // Regression guard: the gorhom BottomSheetModal does not present on
    // react-native-web, so compact web MUST NOT take the native-sheet path.
    expect(resolveComboboxPresentation({ isCompact: true, isNativeRuntime: false })).toBe(
      "web-modal",
    );
  });

  it("uses the desktop popover on wide layouts regardless of runtime", () => {
    expect(resolveComboboxPresentation({ isCompact: false, isNativeRuntime: false })).toBe(
      "desktop",
    );
    expect(resolveComboboxPresentation({ isCompact: false, isNativeRuntime: true })).toBe(
      "desktop",
    );
  });
});
