import { describe, expect, it } from "vitest";
import type { ConfirmDialogInput } from "@/utils/confirm-dialog";
import {
  requestDeleteAutomation,
  resolveDeleteAutomationDialog,
  type DeleteAutomationDeps,
  type DeleteAutomationInput,
} from "./delete-automation-flow";

interface FakeDeleteEnv {
  deps: DeleteAutomationDeps;
  recordedDeletes: DeleteAutomationInput[];
  recordedConfirmInputs: ConfirmDialogInput[];
  recordedErrors: unknown[];
  deletedCount: number;
}

function createFakeEnv(
  options: { confirmResult?: boolean; deleteThrows?: unknown } = {},
): FakeDeleteEnv {
  const env: FakeDeleteEnv = {
    recordedDeletes: [],
    recordedConfirmInputs: [],
    recordedErrors: [],
    deletedCount: 0,
    deps: {
      confirm: async (input) => {
        env.recordedConfirmInputs.push(input);
        return options.confirmResult ?? false;
      },
      deleteAutomation: async (input) => {
        if (options.deleteThrows !== undefined) {
          throw options.deleteThrows;
        }
        env.recordedDeletes.push(input);
      },
      onDeleted: () => {
        env.deletedCount += 1;
      },
      reportError: (error) => {
        env.recordedErrors.push(error);
      },
    },
  };
  return env;
}

const SCHEDULE_INPUT: DeleteAutomationInput = { id: "sched_1", kind: "schedule" };

describe("resolveDeleteAutomationDialog", () => {
  it("returns a web-safe confirm input (labelled buttons + destructive)", () => {
    // The web backend renders this via window.confirm, so it must carry explicit
    // labels and the destructive flag — never rely on react-native Alert.alert,
    // which is a no-op on react-native-web.
    expect(resolveDeleteAutomationDialog()).toEqual({
      title: "Delete automation",
      message: "This cannot be undone.",
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
      destructive: true,
    });
  });
});

describe("requestDeleteAutomation", () => {
  it("deletes and navigates away when the user confirms", async () => {
    const env = createFakeEnv({ confirmResult: true });

    await requestDeleteAutomation(SCHEDULE_INPUT, env.deps);

    expect(env.recordedConfirmInputs).toEqual([resolveDeleteAutomationDialog()]);
    expect(env.recordedDeletes).toEqual([SCHEDULE_INPUT]);
    expect(env.deletedCount).toBe(1);
  });

  it("passes the webhook kind straight through to the delete call", async () => {
    const env = createFakeEnv({ confirmResult: true });

    await requestDeleteAutomation({ id: "wh_1", kind: "webhook" }, env.deps);

    expect(env.recordedDeletes).toEqual([{ id: "wh_1", kind: "webhook" }]);
  });

  it("does nothing when the user cancels", async () => {
    const env = createFakeEnv({ confirmResult: false });

    await requestDeleteAutomation(SCHEDULE_INPUT, env.deps);

    expect(env.recordedConfirmInputs).toHaveLength(1);
    expect(env.recordedDeletes).toEqual([]);
    expect(env.deletedCount).toBe(0);
  });

  it("reports delete failures and does not navigate away", async () => {
    const error = new Error("daemon offline");
    const env = createFakeEnv({ confirmResult: true, deleteThrows: error });

    await expect(requestDeleteAutomation(SCHEDULE_INPUT, env.deps)).resolves.toBeUndefined();

    expect(env.recordedErrors).toEqual([error]);
    expect(env.deletedCount).toBe(0);
  });
});
