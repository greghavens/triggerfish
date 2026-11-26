/** Transfer exact delivery admission without granting live team membership. */
import { join } from "@std/path";
import type { DatabaseSync } from "node:sqlite";
import type { ExecutionTraceScope } from "../../../core/execution_traces.ts";
import {
  canFlowTo,
  parseClassification,
} from "../../../core/types/classification.ts";
import type { SessionId } from "../../../core/types/session.ts";
import { parseTeamDeliveryTraceSource } from "../../../core/team_delivery_trace_source.ts";
import { teamDeliveryExecutionId } from "./delegated_agent_recovery.ts";
import { withTeamRecoveryStore } from "./team_recovery_store.ts";

const digest = /^[a-f0-9]{64}$/;
const fields = [
  "id",
  "teamId",
  "senderSessionId",
  "recipientSessionId",
  "requestDigest",
  "memberContextDigest",
  "observationGrantDigest",
  "senderTaint",
  "memberTaint",
  "ownerTargetClassification",
  "targetClassification",
] as const;

export function teamAdmissionArchive(
  baseDir: string,
  scope: ExecutionTraceScope,
) {
  const source = parseTeamDeliveryTraceSource(scope.sourceId);
  if (!source || scope.role !== "delegated" || !scope.classification) return;
  const { delivery, sender: owner, teamId } = source;
  const path = join(baseDir, "team-recovery.db");
  function parse(raw: unknown) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const record = raw as Record<string, unknown>;
    if (
      Object.keys(record).some((key) =>
        !fields.some((field) => field === key)
      ) ||
      record.id !== delivery || record.teamId !== teamId ||
      record.senderSessionId !== owner ||
      record.recipientSessionId !== scope.sessionId ||
      record.targetClassification !== scope.classification ||
      typeof record.requestDigest !== "string" ||
      !digest.test(record.requestDigest) ||
      typeof record.memberContextDigest !== "string" ||
      !digest.test(record.memberContextDigest) ||
      (record.observationGrantDigest !== undefined &&
        (typeof record.observationGrantDigest !== "string" ||
          !digest.test(record.observationGrantDigest)))
    ) return;
    const levels = [
      record.senderTaint,
      record.memberTaint,
      record.targetClassification,
      record.ownerTargetClassification,
    ].map((value) => {
      if (typeof value !== "string") return;
      const parsed = parseClassification(value);
      return parsed.ok && parsed.value === value ? parsed : undefined;
    });
    const [sender, member, target, ownerTarget] = levels;
    if (
      !sender?.ok || !member?.ok || !target?.ok || !ownerTarget?.ok ||
      !canFlowTo(sender.value, member.value) ||
      !canFlowTo(member.value, target.value) ||
      !canFlowTo(target.value, ownerTarget.value)
    ) return;
    return Object.fromEntries(
      fields.filter((field) => record[field] !== undefined)
        .map((field) => [field, record[field]]),
    );
  }
  const exactBinding = async () =>
    scope.runId === await teamDeliveryExecutionId(
      owner,
      scope.sessionId as SessionId,
      delivery,
    );
  return {
    async read() {
      if (!await exactBinding()) return;
      try {
        Deno.lstatSync(path);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return;
        throw error;
      }
      return withTeamRecoveryStore(
        path,
        (store) => parse(store.delivery(delivery)),
      );
    },
    async restore(raw: unknown) {
      const record = parse(raw);
      if (!record || !await exactBinding()) return;
      withTeamRecoveryStore(path, () => {});
      return {
        path,
        install(db: DatabaseSync) {
          const id = delivery;
          const value = JSON.stringify(record);
          const existing = db.prepare(
            "SELECT value FROM archive_admission.team_recovery_deliveries WHERE id = ?",
          ).get(id);
          if (existing) return existing.value === value;
          return db.prepare(
            "INSERT INTO archive_admission.team_recovery_deliveries VALUES (?, ?)",
          ).run(id, value).changes === 1;
        },
      };
    },
  };
}
