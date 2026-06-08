// D-3.10 / D-3.11 contract tests for the cloud-mode boot probe.
//
// The probe lives inside the daemon's IAM grant (D-3.11 inline policy
// LeadingKeys). These tests pin that contract by:
//
//   1. Asserting the probe reads a pk whose suffix is in
//      DAEMON_OWNED_PARTITION_PREFIXES — i.e., the probe never reads a
//      control-plane row (#metadata, #state, etc.) that the D-3.11 IAM
//      template intentionally denies to the daemon.
//   2. Asserting the probe hard-fails on AccessDenied (mirrors the live
//      failure mode we hit when the probe was reading #metadata against a
//      D-3.11-narrowed IAM grant — daemon must refuse to start so the
//      lifecycle-worker / ECS scanner observes a clean failure).
//   3. Asserting the probe succeeds on "no Item" (the normal happy path —
//      the sentinel sk never matches a real row).
//
// If someone re-introduces a control-plane read to the probe, test 1 fails.
// If someone removes the hard-fail (e.g., reverts to warn-and-continue),
// test 2 fails. Either failure indicates the D-3.10 / D-3.11 contract has
// drifted; pause and re-check workspace-role-template.ts.

import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import {
  DAEMON_OWNED_PARTITION_PREFIXES,
  selfProbeDdb,
  type DaemonOwnedPartitionPrefix,
} from "./bootstrap.js";
import { InMemoryDynamoClient, type DynamoLike } from "./cloud-dynamo-client.js";

const silentLogger = pino({ level: "silent" });
const TEST_WORKSPACE_ID = "ws_test_d3_10_probe";
const TEST_TABLE = "orchestra-test-state";

describe("D-3.10 / D-3.12 boot probe — DAEMON_OWNED_PARTITION_PREFIXES contract", () => {
  test("includes the daemon Dynamo*Store surfaces (D-3.10 chat / permission / loop / schedule / agent#timeline + D-3.12 agent#metadata / project)", () => {
    expect(DAEMON_OWNED_PARTITION_PREFIXES).toEqual([
      "chat",
      "permission",
      "loop",
      "schedule",
      "agent#timeline",
      "agent#metadata",
      "project",
      // D-3.5c — scoped env-var store partition (`<ws>#envvar`).
      "envvar",
    ]);
  });

  test("does NOT include any control-plane prefix (auth/lifecycle-worker-owned)", () => {
    const controlPlanePrefixes = [
      "metadata",
      "state",
      "download-token",
      "webhook-event",
      "spend",
      "quota",
      "keypair",
    ];
    for (const cp of controlPlanePrefixes) {
      expect(DAEMON_OWNED_PARTITION_PREFIXES as readonly string[]).not.toContain(cp);
    }
  });
});

describe("D-3.10 boot probe — pk selection", () => {
  test("issues GetItem against a daemon-owned partition (no control-plane reads)", async () => {
    const reads: Array<{ table: string; pk: string; sk: string }> = [];
    const recording: DynamoLike = {
      ...new InMemoryDynamoClient(),
      get: async (table, key) => {
        reads.push({ table, pk: key.pk, sk: key.sk });
        return {};
      },
    };

    await selfProbeDdb({
      client: recording,
      table: TEST_TABLE,
      workspaceId: TEST_WORKSPACE_ID,
      logger: silentLogger,
    });

    expect(reads).toHaveLength(1);
    const allowed = DAEMON_OWNED_PARTITION_PREFIXES.map((p) => `${TEST_WORKSPACE_ID}#${p}`);
    expect(allowed).toContain(reads[0]?.pk);
    expect(reads[0]?.sk).toMatch(/^__/); // sentinel sk, never a real row
  });

  test("probe pk matches the regex `<wsId>#<daemon-owned-prefix>` exactly (no #metadata, no #state)", async () => {
    const reads: Array<{ pk: string }> = [];
    const recording: DynamoLike = {
      ...new InMemoryDynamoClient(),
      get: async (_table, key) => {
        reads.push({ pk: key.pk });
        return {};
      },
    };

    await selfProbeDdb({
      client: recording,
      table: TEST_TABLE,
      workspaceId: TEST_WORKSPACE_ID,
      logger: silentLogger,
    });

    const prefixPattern = DAEMON_OWNED_PARTITION_PREFIXES.map((p) =>
      p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ).join("|");
    const expectedPattern = new RegExp(`^${TEST_WORKSPACE_ID}#(?:${prefixPattern})$`);
    expect(reads[0]?.pk).toMatch(expectedPattern);
  });
});

describe("D-3.10 boot probe — failure semantics", () => {
  test("returns silently when DDB GetItem returns no Item (happy path)", async () => {
    const client = new InMemoryDynamoClient();
    await expect(
      selfProbeDdb({
        client,
        table: TEST_TABLE,
        workspaceId: TEST_WORKSPACE_ID,
        logger: silentLogger,
      }),
    ).resolves.toBeUndefined();
  });

  test("throws (refusing to start) when DDB GetItem rejects with AccessDeniedException", async () => {
    const accessDeniedClient: DynamoLike = {
      ...new InMemoryDynamoClient(),
      get: async () => {
        const err = new Error(
          `User: arn:aws:sts::000000000000:assumed-role/paseo-ws-${TEST_WORKSPACE_ID}/task ` +
            `is not authorized to perform: dynamodb:GetItem on resource: ${TEST_TABLE} ` +
            `because no identity-based policy allows the dynamodb:GetItem action`,
        );
        (err as Error & { name: string }).name = "AccessDeniedException";
        throw err;
      },
    };

    await expect(
      selfProbeDdb({
        client: accessDeniedClient,
        table: TEST_TABLE,
        workspaceId: TEST_WORKSPACE_ID,
        logger: silentLogger,
      }),
    ).rejects.toThrow(/D-3\.10 boot probe failed/);
  });

  test("throws on transport-level error (timeout / network / DNS)", async () => {
    const networkErrorClient: DynamoLike = {
      ...new InMemoryDynamoClient(),
      get: async () => {
        throw new Error("getaddrinfo ENOTFOUND dynamodb.ap-southeast-2.amazonaws.com");
      },
    };

    await expect(
      selfProbeDdb({
        client: networkErrorClient,
        table: TEST_TABLE,
        workspaceId: TEST_WORKSPACE_ID,
        logger: silentLogger,
      }),
    ).rejects.toThrow(/D-3\.10 boot probe failed/);
  });

  test("preserves the original error as `cause` (debuggability)", async () => {
    const originalError = new Error("synthetic IAM rejection");
    const failingClient: DynamoLike = {
      ...new InMemoryDynamoClient(),
      get: async () => {
        throw originalError;
      },
    };

    try {
      await selfProbeDdb({
        client: failingClient,
        table: TEST_TABLE,
        workspaceId: TEST_WORKSPACE_ID,
        logger: silentLogger,
      });
      expect.unreachable("selfProbeDdb should have thrown");
    } catch (err) {
      expect((err as Error & { cause: unknown }).cause).toBe(originalError);
    }
  });
});

describe("D-3.10 / D-3.12 boot probe — type contract", () => {
  test("DaemonOwnedPartitionPrefix narrows to the constant's union", () => {
    const chat: DaemonOwnedPartitionPrefix = "chat";
    const perm: DaemonOwnedPartitionPrefix = "permission";
    const loop: DaemonOwnedPartitionPrefix = "loop";
    const sched: DaemonOwnedPartitionPrefix = "schedule";
    const agentTimeline: DaemonOwnedPartitionPrefix = "agent#timeline";
    const agentMetadata: DaemonOwnedPartitionPrefix = "agent#metadata";
    const project: DaemonOwnedPartitionPrefix = "project";
    const envvar: DaemonOwnedPartitionPrefix = "envvar";
    expect([chat, perm, loop, sched, agentTimeline, agentMetadata, project, envvar]).toHaveLength(
      8,
    );

    // @ts-expect-error — "metadata" is intentionally not assignable
    //   (the workspace-metadata control-plane partition is auth-owned;
    //   `agent#metadata` is the daemon's agent-record partition and is
    //   spelled out in full).
    const metadata: DaemonOwnedPartitionPrefix = "metadata";
    expect(metadata).toBe("metadata"); // runtime assertion; type-check is the real assertion
  });

  test("partition list size is stable (forces explicit review when new surfaces are added)", () => {
    // If you're adding a new Dynamo*Store surface, update the IAM template at
    // orchestra-cloud-private/packages/cloud-shared/src/workspace-role-template.ts
    // FIRST, then bump this expected length AND DAEMON_OWNED_PARTITION_PREFIXES.
    // D-3.10 shipped 5; D-3.12 added agent#metadata + project for the
    // file-backed AgentStorage + FileBackedProjectRegistry cloud-mode
    // replacement; D-3.5c added envvar for the scoped env-var store.
    expect(DAEMON_OWNED_PARTITION_PREFIXES.length).toBe(8);
  });
});

// Suppress unused-import warning if vi isn't used in further additions.
void vi;
