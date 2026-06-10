// @vitest-environment jsdom
//
// Behavioral proof for the iOS-Safari combobox fix: on a COMPACT WEB viewport the
// shared Combobox must render its options through an RN `Modal` (WebMobileComboboxBody)
// — NOT @gorhom/bottom-sheet, whose BottomSheetModal does not present on
// react-native-web. We force isWeb + compact and assert the web-modal container and
// its options render and select, while the gorhom sheet is never presented.
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme, presentSpy } = vi.hoisted(() => ({
  presentSpy: vi.fn(),
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 6: 24, 8: 32 },
    fontSize: { xs: 11, sm: 13, lg: 18 },
    fontWeight: { medium: "500" },
    borderRadius: { lg: 8, "2xl": 16, full: 999 },
    shadow: { md: {} },
    colors: {
      surface0: "#0a0a0a",
      surface1: "#111",
      surface2: "#222",
      border: "#333",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      palette: { zinc: { 600: "#52525b" } },
    },
  },
}));

vi.mock("@/constants/platform", () => ({ isWeb: true, isNative: false }));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => true }));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
}));

// Keep View/Text/Modal/ScrollView/TextInput from react-native-web (the vitest alias),
// but map Pressable's onPress→onClick so jsdom clicks fire (RNW's press responder
// does not run under plain MouseEvents in jsdom).
vi.mock("react-native", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const MockPressable = ({
    children,
    onPress,
    disabled,
    testID,
    accessibilityLabel,
    accessibilityRole,
    style: _style,
    ...rest
  }: Record<string, unknown>) =>
    React.createElement(
      "button",
      {
        type: "button",
        "data-testid": testID,
        "aria-label": accessibilityLabel,
        role: accessibilityRole,
        disabled,
        onClick: () => {
          if (!disabled && typeof onPress === "function") onPress();
        },
        ...rest,
      },
      children as React.ReactNode,
    );
  return { ...actual, Pressable: MockPressable };
});

vi.mock("@gorhom/bottom-sheet", () => ({
  BottomSheetScrollView: "div",
  BottomSheetBackdrop: () => null,
  BottomSheetTextInput: "input",
}));

vi.mock("react-native-reanimated", () => ({
  default: { View: "div" },
  FadeIn: { duration: () => undefined },
  FadeOut: { duration: () => undefined },
}));

vi.mock("@floating-ui/react-native", () => ({
  useFloating: () => ({
    refs: { setFloating: () => {}, setReference: () => {}, setOffsetParent: () => {} },
    floatingStyles: { left: 0, top: 0 },
    update: () => {},
  }),
  flip: () => ({}),
  offset: () => ({}),
  shift: () => ({}),
  size: () => ({}),
}));

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": name });
  return {
    Check: icon("Check"),
    File: icon("File"),
    Folder: icon("Folder"),
    Search: icon("Search"),
  };
});

// Replace the gorhom-backed mobile sheet so we can assert it is NEVER presented on web.
vi.mock("./isolated-bottom-sheet-modal", () => ({
  IsolatedBottomSheetModal: () => null,
  useIsolatedBottomSheetVisibility: () => {
    presentSpy();
    return { sheetRef: () => {}, handleSheetChange: () => {}, handleSheetDismiss: () => {} };
  },
}));

import { View } from "react-native";
import { Combobox, type ComboboxOption } from "./combobox";

const OPTIONS: ComboboxOption[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

describe("Combobox — compact web (mobile Safari)", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    presentSpy.mockClear();
  });

  function AnchoredCombobox(props: {
    open: boolean;
    onSelect: (id: string) => void;
    onOpenChange: (open: boolean) => void;
  }) {
    const anchorRef = React.useRef<View>(null);
    return (
      <Combobox
        options={OPTIONS}
        value="claude"
        searchable={false}
        open={props.open}
        onSelect={props.onSelect}
        onOpenChange={props.onOpenChange}
        anchorRef={anchorRef}
        title="Select provider"
      />
    );
  }

  function findByText(text: string): HTMLElement | null {
    return (
      (Array.from(document.body.querySelectorAll("button, div, span")).find(
        (el) => el.textContent === text,
      ) as HTMLElement | null) ?? null
    );
  }

  it("renders options in the web Modal sheet and never presents the gorhom sheet", () => {
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();

    act(() => {
      root?.render(<AnchoredCombobox open onSelect={onSelect} onOpenChange={onOpenChange} />);
    });

    expect(document.querySelector('[data-testid="combobox-mobile-web-container"]')).not.toBeNull();
    // No gorhom bottom-sheet markup should be in the tree on web.
    expect(document.querySelector('[data-testid="bottom-sheet"]')).toBeNull();
    expect(findByText("Claude Code")).not.toBeNull();
    expect(findByText("Codex")).not.toBeNull();
  });

  it("selects an option on tap and closes", () => {
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();

    act(() => {
      root?.render(<AnchoredCombobox open onSelect={onSelect} onOpenChange={onOpenChange} />);
    });

    const codex = findByText("Codex");
    expect(codex).not.toBeNull();
    const pressable = codex?.closest("button");
    act(() => {
      pressable?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    expect(onSelect).toHaveBeenCalledWith("codex");
    // Default keepOpenOnSelect=false → picker requests close.
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("hides the web Modal container when closed", () => {
    act(() => {
      root?.render(<AnchoredCombobox open={false} onSelect={vi.fn()} onOpenChange={vi.fn()} />);
    });

    expect(document.querySelector('[data-testid="combobox-mobile-web-container"]')).toBeNull();
  });
});
