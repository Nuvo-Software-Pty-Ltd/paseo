import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { invalidateCloudWorkspacesCache } from "./cloud-workspaces-cache";

// Asserted-equal in the first test below so a rename of either constant
// throws a noisy regression — the F9 single-key contract that Tasks 4, 5,
// 9 all depend on.
const EXPECTED_KEY = ["cloud-workspaces"] as const;

describe("invalidateCloudWorkspacesCache", () => {
  it("invalidates exactly the cloud-workspaces query key", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    invalidateCloudWorkspacesCache(queryClient);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toEqual({ queryKey: EXPECTED_KEY });
  });

  it("two parallel invocations are safe (no double-fetch storm for an inactive query)", async () => {
    const queryFn = vi.fn().mockResolvedValue([]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await queryClient.prefetchQuery({
      queryKey: EXPECTED_KEY,
      queryFn,
    });
    queryFn.mockClear();

    invalidateCloudWorkspacesCache(queryClient);
    invalidateCloudWorkspacesCache(queryClient);
    await queryClient.refetchQueries({ queryKey: EXPECTED_KEY });

    // Two invalidate calls + one explicit refetch must trigger queryFn at
    // most once (no observers; refetchQueries is the only fetch trigger).
    expect(queryFn).toHaveBeenCalledTimes(1);
  });
});
