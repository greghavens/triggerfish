/** Durable metadata for an already authenticated webhook delivery. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ClassificationLevel } from "../../core/types/classification.ts";
import { schedulerAdmissionDatabase } from "../admission_database.ts";
import type { SchedulerServiceConfig } from "../service_types.ts";

export interface WebhookAdmission {
  readonly id: string;
  readonly sourceId: string;
  readonly ceiling: ClassificationLevel;
  readonly policySha256: string;
  readonly promptDigest: string;
  readonly credentialProof: string;
}

export interface WebhookAdmissionClaim {
  readonly id: string;
  readonly token: string;
}

const ADMISSION_LEASE_MS = 300_000;
const WEBHOOK_EXECUTION_ID = /^scheduler-webhook-[a-f0-9]{64}$/;

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Capture the exact policy and secret used to verify a delivery. */
export function webhookAdmissionPolicy(
  config: SchedulerServiceConfig["webhooks"],
  sourceId: string,
) {
  const source = Object.hasOwn(config.sources, sourceId)
    ? config.sources[sourceId]
    : undefined;
  if (!config.enabled || !source) return undefined;
  const rate = source.rateLimit ?? config.rateLimit;
  const maxAgeMs = config.maxAgeMs ?? 300_000;
  const allowBodySignature = source.allowBodySignature === true;
  return {
    secret: source.secret,
    ceiling: source.classification,
    maxAgeMs,
    allowBodySignature,
    policySha256: digest(JSON.stringify([
      maxAgeMs,
      allowBodySignature,
      rate?.perMinute ?? 60,
      rate?.burst ?? 10,
    ])),
  };
}

export function prepareWebhookAdmission(
  id: string,
  sourceId: string,
  prompt: string,
  policy: NonNullable<ReturnType<typeof webhookAdmissionPolicy>>,
): WebhookAdmission {
  const { ceiling, policySha256 } = policy;
  const promptDigest = createHmac("sha256", policy.secret).update(
    JSON.stringify(["triggerfish-webhook-prompt:v1", prompt]),
  ).digest("hex");
  const credentialProof = createHmac("sha256", policy.secret).update(
    JSON.stringify([
      "triggerfish-webhook-admission:v1",
      id,
      sourceId,
      ceiling,
      policySha256,
      promptDigest,
    ]),
  ).digest("hex");
  return { id, sourceId, ceiling, policySha256, promptDigest, credentialProof };
}

export function sameWebhookAdmission(
  expected: WebhookAdmission,
  actual: WebhookAdmission,
): boolean {
  const encoder = new TextEncoder();
  return expected.id === actual.id &&
    expected.sourceId === actual.sourceId &&
    expected.ceiling === actual.ceiling &&
    expected.policySha256 === actual.policySha256 &&
    expected.promptDigest === actual.promptDigest &&
    /^[a-f0-9]{64}$/.test(expected.credentialProof) &&
    timingSafeEqual(
      encoder.encode(expected.credentialProof),
      encoder.encode(actual.credentialProof),
    );
}

/** Open a journal used by public admission and explicit operator resumption. */
export function openSchedulerWebhookAdmissions(path: string) {
  const withDatabase = schedulerAdmissionDatabase(path);
  withDatabase((db) =>
    db.exec(`CREATE TABLE IF NOT EXISTS webhook_admissions (
      id TEXT PRIMARY KEY,
      sourceId TEXT NOT NULL,
      ceiling TEXT NOT NULL,
      policySha256 TEXT NOT NULL,
      promptDigest TEXT NOT NULL,
      credentialProof TEXT NOT NULL,
      leaseToken TEXT,
      leaseUntil INTEGER,
      completed INTEGER NOT NULL DEFAULT 0
    ) STRICT;`)
  );
  return {
    has(id: string): boolean {
      return withDatabase((db) =>
        db.prepare("SELECT 1 FROM webhook_admissions WHERE id = ?").get(id) !==
          undefined
      );
    },
    admit(admission: WebhookAdmission): WebhookAdmissionClaim | undefined {
      const token = crypto.randomUUID();
      const inserted = withDatabase((db) =>
        db.prepare(`INSERT OR IGNORE INTO webhook_admissions
          (id,sourceId,ceiling,policySha256,promptDigest,credentialProof,leaseToken,leaseUntil)
          VALUES (?,?,?,?,?,?,?,?)`).run(
          admission.id,
          admission.sourceId,
          admission.ceiling,
          admission.policySha256,
          admission.promptDigest,
          admission.credentialProof,
          token,
          Date.now() + ADMISSION_LEASE_MS,
        ).changes
      );
      return inserted === 1 ? { id: admission.id, token } : undefined;
    },
    readPending(id: string): WebhookAdmission | undefined {
      if (!WEBHOOK_EXECUTION_ID.test(id)) return undefined;
      return withDatabase((db) =>
        db.prepare(
          `SELECT id,sourceId,ceiling,policySha256,promptDigest,credentialProof
          FROM webhook_admissions WHERE id=? AND completed=0`,
        ).get(id) as unknown as
          | WebhookAdmission
          | undefined
      );
    },
    claim(admission: WebhookAdmission): WebhookAdmissionClaim | undefined {
      const token = crypto.randomUUID();
      const now = Date.now();
      const changed = withDatabase((db) =>
        db.prepare(`UPDATE webhook_admissions SET leaseToken=?, leaseUntil=?
          WHERE id=? AND sourceId=? AND ceiling=? AND policySha256=?
          AND promptDigest=? AND credentialProof=? AND completed=0
          AND (leaseUntil IS NULL OR leaseUntil<=?)`).run(
          token,
          now + ADMISSION_LEASE_MS,
          admission.id,
          admission.sourceId,
          admission.ceiling,
          admission.policySha256,
          admission.promptDigest,
          admission.credentialProof,
          now,
        ).changes
      );
      return changed === 1 ? { id: admission.id, token } : undefined;
    },
    settle(claim: WebhookAdmissionClaim, completed: boolean): void {
      withDatabase((db) =>
        db.prepare(
          `UPDATE webhook_admissions SET completed=?, leaseToken=NULL, leaseUntil=NULL
          WHERE id=? AND leaseToken=?`,
        ).run(
          completed ? 1 : 0,
          claim.id,
          claim.token,
        )
      );
    },
  };
}

export type SchedulerWebhookAdmissions = ReturnType<
  typeof openSchedulerWebhookAdmissions
>;
