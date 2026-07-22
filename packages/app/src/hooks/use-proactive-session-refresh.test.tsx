/**
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/orchestra-cloud-client", () => ({
  proactivelyRefreshSession: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/hooks/use-app-visible", () => ({
  useAppVisible: vi.fn(() => true),
}));

import { proactivelyRefreshSession } from "@/lib/orchestra-cloud-client";
import { useAppVisible } from "@/hooks/use-app-visible";
import { useProactiveSessionRefresh } from "./use-proactive-session-refresh";

const refresh = vi.mocked(proactivelyRefreshSession);
const visible = vi.mocked(useAppVisible);

beforeEach(() => {
  refresh.mockClear();
  visible.mockReturnValue(true);
});

describe("useProactiveSessionRefresh", () => {
  it("refreshes once on launch (mount)", () => {
    renderHook(() => useProactiveSessionRefresh());
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes again only on a background→foreground transition", () => {
    visible.mockReturnValue(false);
    const { rerender } = renderHook(() => useProactiveSessionRefresh());
    expect(refresh).toHaveBeenCalledTimes(1); // launch, even while backgrounded

    visible.mockReturnValue(true);
    rerender();
    expect(refresh).toHaveBeenCalledTimes(2); // returned to foreground

    rerender(); // still visible — no new transition
    expect(refresh).toHaveBeenCalledTimes(2);

    visible.mockReturnValue(false);
    rerender(); // went to background — must NOT refresh
    expect(refresh).toHaveBeenCalledTimes(2);

    visible.mockReturnValue(true);
    rerender(); // foreground again
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});
