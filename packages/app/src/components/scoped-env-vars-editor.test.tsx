/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16 },
    borderRadius: { sm: 4, md: 6, lg: 8 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400", medium: "500", semibold: "600" },
    colors: {
      surface1: "#111",
      surface2: "#222",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#555",
      accent: "#0a84ff",
      destructive: "#ff4444",
    },
  },
}));

// Hook seam — the component is the unit under test; the RPC hook is mocked.
const hookState = vi.hoisted(() => ({
  supported: true,
  vars: [] as Array<{ key: string; value: string; secret?: boolean; updatedAt: string }>,
  setVar: vi.fn(async () => ({ ok: true }) as { ok: true } | { ok: false; code?: string }),
  deleteVar: vi.fn(async () => {}),
}));

vi.mock("@/hooks/use-scoped-env-vars", () => ({
  useScopedEnvVarsSupported: () => hookState.supported,
  useScopedEnvVars: () => ({
    vars: hookState.vars,
    isLoading: false,
    isError: false,
    setVar: hookState.setVar,
    deleteVar: hookState.deleteVar,
    refetch: () => {},
  }),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("react-native", () => {
  const make = (tag: string) => (props: Record<string, unknown>) => {
    const { children, onChangeText: _onChangeText, onValueChange: _onValueChange, ...rest } = props;
    return React.createElement(tag, rest, children as React.ReactNode);
  };
  return {
    View: make("div"),
    Text: make("span"),
    TextInput: make("input"),
    Pressable: (props: Record<string, unknown>) => {
      const { children, onPress, ...rest } = props;
      return React.createElement(
        "button",
        { type: "button", ...rest, onClick: onPress as () => void },
        children as React.ReactNode,
      );
    },
  };
});

// The env-vars editor only uses maskPaneProps() (session-replay masking); stub the PostHog
// barrel so this unit test doesn't pull in the native SDK + platform constants.
vi.mock("@/lib/posthog", () => ({ maskPaneProps: () => ({}) }));

vi.mock("@/components/ui/button", () => ({
  Button: (props: Record<string, unknown>) =>
    React.createElement(
      "button",
      { type: "button", onClick: props.onPress as () => void, "data-testid": props.testID },
      props.children as React.ReactNode,
    ),
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: (props: Record<string, unknown>) =>
    React.createElement("input", {
      type: "checkbox",
      "data-testid": props.testID,
      checked: props.value as boolean,
      readOnly: true,
    }),
}));

vi.mock("@/utils/confirm-dialog", () => ({
  confirmDialog: vi.fn(async () => true),
}));

vi.mock("lucide-react-native", () => ({
  Trash2: (props: Record<string, unknown>) => React.createElement("span", { ...props }),
}));

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { ScopedEnvVarsEditor } from "./scoped-env-vars-editor";

const INHERITED_FIXTURE = [{ key: "API_BASE", value: "w", updatedAt: "t" }];

describe("ScopedEnvVarsEditor", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    hookState.supported = true;
    hookState.vars = [];
    hookState.setVar.mockClear();
    hookState.deleteVar.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = null;
    container?.remove();
    container = null;
  });

  it("shows the 'update the host' message when the capability is absent", () => {
    hookState.supported = false;
    act(() => {
      root?.render(<ScopedEnvVarsEditor serverId="s1" scope="project" scopeId="proj_1" />);
    });
    expect(container?.textContent).toContain("Update the host to use this.");
  });

  it("renders the precedence note for the project scope", () => {
    act(() => {
      root?.render(<ScopedEnvVarsEditor serverId="s1" scope="project" scopeId="proj_1" />);
    });
    expect(container?.textContent).toContain(
      "Workspace variables apply to every project. Set a variable here to override it for this project.",
    );
  });

  it("renders inherited workspace vars and badges a project var that overrides one", () => {
    hookState.vars = [{ key: "API_BASE", value: "p", updatedAt: "t" }];
    act(() => {
      root?.render(
        <ScopedEnvVarsEditor
          serverId="s1"
          scope="project"
          scopeId="proj_1"
          inheritedVars={INHERITED_FIXTURE}
        />,
      );
    });
    expect(container?.textContent).toContain("Inherited from workspace");
    expect(container?.textContent).toContain("overrides workspace");
  });

  it("masks secret values", () => {
    hookState.vars = [{ key: "TOKEN", value: "sk-real", secret: true, updatedAt: "t" }];
    act(() => {
      root?.render(<ScopedEnvVarsEditor serverId="s1" scope="project" scopeId="proj_1" />);
    });
    expect(container?.textContent).not.toContain("sk-real");
    expect(container?.textContent).toContain("••••••••");
  });
});
