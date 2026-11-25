import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  AgentRecoveryStore,
  type RecoveryToolReceipt,
} from "../../src/core/agent_recovery_store.ts";
import type { AgentTurnCheckpoint } from "../../src/core/types/orchestrator.ts";

const binding = "a".repeat(64);
const otherBinding = "b".repeat(64);

function checkpoint(batch: number): AgentTurnCheckpoint {
  return {
    history: [
      { role: "user", content: "Review committed control facts." },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "provider-call",
          type: "function",
          function: { name: "read_control", arguments: "{}" },
        }],
      },
      {
        role: "tool",
        content: "Verified control.",
        tool_call_id: "provider-call",
      },
    ],
    completedIterations: batch,
    tokenUsage: { inputTokens: 20, outputTokens: 8 },
    nudgeCount: 0,
    eosRetries: 0,
    toolCallCounts: [["read_control:{}", 1]],
  };
}
const receipt: RecoveryToolReceipt = {
  name: "read_control",
  callId: "1:0",
  args: { reference: "opaque:verified" },
  classification: "INTERNAL",
  resultSha256: "c".repeat(64),
};

Deno.test("Recovery checkpoints are single-writer, immutable per batch and fail closed after interrupted dispatch", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "agent-recovery.db");
  const key = "team:delivery:known";
  try {
    const first = new AgentRecoveryStore(path);
    const concurrent = new AgentRecoveryStore(path);
    try {
      assertEquals(first.begin(key, binding), {
        key,
        binding,
        status: "ready",
        committedBatch: 0,
        tools: [],
      });
      assertEquals(concurrent.begin(key, otherBinding), undefined);
      assert(first.beginBatch(key, binding, 1, 0));
      assert(!concurrent.beginBatch(key, binding, 1));
      assert(!concurrent.beginBatch(key, binding, 2));
      assert(!concurrent.finish(key, binding));
      assert(
        !concurrent.commitBatch(key, otherBinding, 1, checkpoint(1), [receipt]),
      );
      assert(
        !concurrent.commitBatch(key, binding, 2, checkpoint(2), [receipt]),
      );
    } finally {
      concurrent.close();
      first.close();
    }

    const reopened = new AgentRecoveryStore(path);
    try {
      assertEquals(reopened.read(key), {
        key,
        binding,
        status: "pending",
        committedBatch: 0,
        pendingBatch: 1,
        tools: [],
      });
      assert(!reopened.beginBatch(key, binding, 1));
      assert(!reopened.finish(key, binding));
      assert(reopened.commitBatch(key, binding, 1, checkpoint(1), [receipt]));
      assert(!reopened.commitBatch(key, binding, 1, checkpoint(1), [receipt]));
      assertEquals(reopened.read(key), {
        key,
        binding,
        status: "ready",
        committedBatch: 1,
        checkpoint: checkpoint(1),
        tools: [receipt],
      });
      assert(!reopened.beginBatch(key, binding, 1));
      const stale = new AgentRecoveryStore(path);
      try {
        assert(!stale.beginBatch(key, binding, 3, 0));
        assert(!stale.beginBatch(key, binding, 3, 2));
        assertEquals(stale.read(key)?.committedBatch, 1);
        assert(reopened.beginBatch(key, binding, 3, 1));
      } finally {
        stale.close();
      }
      const laterReceipt = { ...receipt, callId: "3:0" };
      assert(
        !reopened.commitBatch(key, binding, 3, checkpoint(3), [laterReceipt]),
      );
      assert(
        !reopened.commitBatch(key, binding, 3, checkpoint(3), [
          { ...receipt, args: { reference: "rewrite" } },
          laterReceipt,
        ]),
      );
      assert(
        !reopened.commitBatch(key, binding, 3, checkpoint(3), [
          receipt,
          { ...laterReceipt, args: { invalid: NaN } },
        ]),
      );
      assert(
        !reopened.commitBatch(key, binding, 3, checkpoint(3), [
          receipt,
          { ...laterReceipt, args: { oversized: "x".repeat(65_536) } },
        ]),
      );
      assert(
        !reopened.commitBatch(key, binding, 3, {
          ...checkpoint(3),
          history: [
            { role: "user", content: "x".repeat(256 * 1024) },
            ...checkpoint(3).history.slice(1),
          ],
        }, [receipt, laterReceipt]),
      );
      const pending = reopened.read(key);
      assertEquals(pending?.status, "pending");
      assertEquals(pending?.committedBatch, 1);
      assert(reopened.commitBatch(key, binding, 3, checkpoint(3), [
        receipt,
        {
          ...laterReceipt,
          rawDispatch: "must not persist",
        } as RecoveryToolReceipt,
      ]));
      assertEquals(reopened.read(key), {
        key,
        binding,
        status: "ready",
        committedBatch: 3,
        checkpoint: checkpoint(3),
        tools: [receipt, laterReceipt],
      });
      const staleFinish = new AgentRecoveryStore(path);
      try {
        assert(!staleFinish.finish(key, binding, 1));
        assert(!staleFinish.finish(key, binding, 4));
        assertEquals(staleFinish.read(key)?.status, "ready");
        assert(reopened.finish(key, binding, 3));
      } finally {
        staleFinish.close();
      }
      assertEquals(reopened.read(key), {
        key,
        binding,
        status: "finished",
        committedBatch: 3,
      });
      assertEquals(reopened.begin(key, binding), reopened.read(key));
      assert(!reopened.beginBatch(key, binding, 4));
      assertThrows(
        () => reopened.begin("another", "raw"),
        Error,
        "binding digest",
      );
    } finally {
      reopened.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
