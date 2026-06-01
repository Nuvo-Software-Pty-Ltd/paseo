// D-3.10 follow-up — buildD3DaemonStores wires DynamoAgentTimelineStore in
// cloud mode and leaves it undefined on-host.
//
// AgentManager accepts `durableTimelineStore?: AgentTimelineStore`; the
// bootstrap injection point lives at the AgentManager constructor call. The
// store value is sourced from `d3Stores.agentTimeline`, which is produced
// here. If the cloud branch ever stops constructing the Dynamo store, agent
// timeline events fall back to InMemoryAgentTimelineStore and silently fail
// to persist across daemon restarts — the same class of bug as the D-3.10
// permission/loop/schedule regression. These tests pin the contract.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { DynamoAgentTimelineStore } from "./agent/dynamo-agent-timeline-store.js";
import { buildD3DaemonStores } from "./bootstrap.js";

const silentLogger = pino({ level: "silent" });

describe("buildD3DaemonStores — agentTimeline wiring (D-3.10 follow-up)", () => {
  const originalCloudMode = process.env.PASEO_CLOUD_MODE;
  const originalWorkspaceId = process.env.PASEO_WORKSPACE_ID;
  const originalRegion = process.env.AWS_REGION;
  let paseoHome: string;

  beforeEach(() => {
    paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-d3-agent-timeline-"));
  });

  afterEach(() => {
    rmSync(paseoHome, { recursive: true, force: true });
    if (originalCloudMode === undefined) {
      delete process.env.PASEO_CLOUD_MODE;
    } else {
      process.env.PASEO_CLOUD_MODE = originalCloudMode;
    }
    if (originalWorkspaceId === undefined) {
      delete process.env.PASEO_WORKSPACE_ID;
    } else {
      process.env.PASEO_WORKSPACE_ID = originalWorkspaceId;
    }
    if (originalRegion === undefined) {
      delete process.env.AWS_REGION;
    } else {
      process.env.AWS_REGION = originalRegion;
    }
  });

  test("on-host mode yields agentTimeline: undefined (AgentManager falls back to InMemoryAgentTimelineStore)", async () => {
    delete process.env.PASEO_CLOUD_MODE;
    delete process.env.PASEO_WORKSPACE_ID;

    const stores = await buildD3DaemonStores({ paseoHome, logger: silentLogger });

    expect(stores.agentTimeline).toBeUndefined();
    expect(stores.dynamoLike).toBeNull();
  });

  test("cloud mode constructs a DynamoAgentTimelineStore wired to the shared DynamoLike client", async () => {
    process.env.PASEO_CLOUD_MODE = "1";
    process.env.PASEO_WORKSPACE_ID = "ws_d3_10_agent_timeline_test";
    // AWS SDK client construction is lazy — no network call happens at
    // build time; the region only needs to be set to a syntactically
    // valid value. We do NOT issue any DDB read/write in this test.
    process.env.AWS_REGION = process.env.AWS_REGION ?? "ap-southeast-2";

    const stores = await buildD3DaemonStores({ paseoHome, logger: silentLogger });

    expect(stores.agentTimeline).toBeInstanceOf(DynamoAgentTimelineStore);
    expect(stores.dynamoLike).not.toBeNull();
  });
});
