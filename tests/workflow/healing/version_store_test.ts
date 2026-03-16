import { assertEquals } from "@std/assert";
import type { StorageProvider } from "../../../src/core/storage/provider.ts";
import { createWorkflowStore } from "../../../src/workflow/store.ts";
import { createWorkflowVersionStore } from "../../../src/workflow/healing/version_store.ts";

function createMemoryStorage(): StorageProvider {
  const data = new Map<string, string>();
  return {
    set(key: string, value: string): Promise<void> {
      data.set(key, value);
      return Promise.resolve();
    },
    get(key: string): Promise<string | null> {
      return Promise.resolve(data.get(key) ?? null);
    },
    delete(key: string): Promise<void> {
      data.delete(key);
      return Promise.resolve();
    },
    list(prefix?: string): Promise<string[]> {
      const keys: string[] = [];
      for (const k of data.keys()) {
        if (!prefix || k.startsWith(prefix)) keys.push(k);
      }
      return Promise.resolve(keys);
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}

const SAMPLE_YAML = `
document:
  dsl: "1.0"
  namespace: test
  name: sample
metadata:
  triggerfish:
    self_healing:
      enabled: true
do:
  - step:
      set:
        x: 1
      metadata:
        description: "Sets x"
        intent: "Initialize"
        expects: "Nothing"
        produces: "x=1"
`;

const MODIFIED_CONFIG_YAML = `
document:
  dsl: "1.0"
  namespace: test
  name: sample
metadata:
  triggerfish:
    self_healing:
      enabled: false
do:
  - step:
      set:
        x: 1
      metadata:
        description: "Sets x"
        intent: "Initialize"
        expects: "Nothing"
        produces: "x=1"
`;

Deno.test("VersionStore: propose and approve lifecycle", async () => {
  const storage = createMemoryStorage();
  const workflowStore = createWorkflowStore(storage);
  await workflowStore.saveWorkflowDefinition("sample", SAMPLE_YAML, "PUBLIC");

  const versionStore = createWorkflowVersionStore({ storage, workflowStore });

  const proposed = await versionStore.proposeWorkflowVersion({
    workflowName: "sample",
    agentId: "agent-1",
    definition: SAMPLE_YAML,
    diff: "no diff",
    source: "self_healing",
    authorReasoning: "Test proposal",
    classification: "PUBLIC",
  });
  assertEquals(proposed.ok, true);
  if (!proposed.ok) return;
  assertEquals(proposed.value.status, "PROPOSED");
  assertEquals(proposed.value.versionNumber, 1);

  const approved = await versionStore.approveWorkflowVersion(
    proposed.value.versionId,
    "reviewer-1",
  );
  assertEquals(approved.ok, true);
  if (!approved.ok) return;
  assertEquals(approved.value.status, "APPROVED");
  assertEquals(approved.value.resolvedBy, "reviewer-1");
});

Deno.test("VersionStore: propose and reject preserved", async () => {
  const storage = createMemoryStorage();
  const workflowStore = createWorkflowStore(storage);
  await workflowStore.saveWorkflowDefinition("sample", SAMPLE_YAML, "PUBLIC");

  const versionStore = createWorkflowVersionStore({ storage, workflowStore });

  const proposed = await versionStore.proposeWorkflowVersion({
    workflowName: "sample",
    agentId: "agent-1",
    definition: SAMPLE_YAML,
    diff: "no diff",
    source: "self_healing",
    authorReasoning: "Bad fix",
    classification: "PUBLIC",
  });
  assertEquals(proposed.ok, true);
  if (!proposed.ok) return;

  const rejected = await versionStore.rejectWorkflowVersion(
    proposed.value.versionId,
    "reviewer-1",
    "Not appropriate",
  );
  assertEquals(rejected.ok, true);
  if (!rejected.ok) return;
  assertEquals(rejected.value.status, "REJECTED");

  const rejectedList = await versionStore.loadRejectedProposals("sample");
  assertEquals(rejectedList.length, 1);
  assertEquals(rejectedList[0].versionId, proposed.value.versionId);
});

Deno.test("VersionStore: SUPERSEDED on re-propose", async () => {
  const storage = createMemoryStorage();
  const workflowStore = createWorkflowStore(storage);
  await workflowStore.saveWorkflowDefinition("sample", SAMPLE_YAML, "PUBLIC");

  const versionStore = createWorkflowVersionStore({ storage, workflowStore });

  const first = await versionStore.proposeWorkflowVersion({
    workflowName: "sample",
    agentId: "agent-1",
    definition: SAMPLE_YAML,
    diff: "diff1",
    source: "self_healing",
    authorReasoning: "First fix",
    classification: "PUBLIC",
  });
  assertEquals(first.ok, true);
  if (!first.ok) return;

  const second = await versionStore.proposeWorkflowVersion({
    workflowName: "sample",
    agentId: "agent-1",
    definition: SAMPLE_YAML,
    diff: "diff2",
    source: "self_healing",
    authorReasoning: "Better fix",
    classification: "PUBLIC",
  });
  assertEquals(second.ok, true);
  if (!second.ok) return;

  const versions = await versionStore.listWorkflowVersions("sample", "PUBLIC");
  const firstVersion = versions.find((v) =>
    v.versionId === first.value.versionId
  );
  assertEquals(firstVersion?.status, "SUPERSEDED");
  assertEquals(second.value.versionNumber, 2);
});

Deno.test("VersionStore: self-healing config mutation rejected", async () => {
  const storage = createMemoryStorage();
  const workflowStore = createWorkflowStore(storage);
  await workflowStore.saveWorkflowDefinition("sample", SAMPLE_YAML, "PUBLIC");

  const versionStore = createWorkflowVersionStore({ storage, workflowStore });

  const result = await versionStore.proposeWorkflowVersion({
    workflowName: "sample",
    agentId: "agent-1",
    definition: MODIFIED_CONFIG_YAML,
    diff: "changed config",
    source: "self_healing",
    authorReasoning: "Disable healing",
    classification: "PUBLIC",
  });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.error.includes("self_healing config block"), true);
});

Deno.test("VersionStore: classification gating on list", async () => {
  const storage = createMemoryStorage();
  const workflowStore = createWorkflowStore(storage);
  await workflowStore.saveWorkflowDefinition(
    "sample",
    SAMPLE_YAML,
    "CONFIDENTIAL",
  );

  const versionStore = createWorkflowVersionStore({ storage, workflowStore });

  await versionStore.proposeWorkflowVersion({
    workflowName: "sample",
    agentId: "agent-1",
    definition: SAMPLE_YAML,
    diff: "diff",
    source: "human",
    authorReasoning: "Manual fix",
    classification: "CONFIDENTIAL",
  });

  const publicList = await versionStore.listWorkflowVersions(
    "sample",
    "PUBLIC",
  );
  assertEquals(publicList.length, 0);

  const confidentialList = await versionStore.listWorkflowVersions(
    "sample",
    "CONFIDENTIAL",
  );
  assertEquals(confidentialList.length, 1);
});

Deno.test("VersionStore: human source bypasses config immutability check", async () => {
  const storage = createMemoryStorage();
  const workflowStore = createWorkflowStore(storage);
  await workflowStore.saveWorkflowDefinition("sample", SAMPLE_YAML, "PUBLIC");

  const versionStore = createWorkflowVersionStore({ storage, workflowStore });

  const result = await versionStore.proposeWorkflowVersion({
    workflowName: "sample",
    agentId: "agent-1",
    definition: MODIFIED_CONFIG_YAML,
    diff: "changed config",
    source: "human",
    authorReasoning: "Owner updated config",
    classification: "PUBLIC",
  });
  assertEquals(result.ok, true);
});
