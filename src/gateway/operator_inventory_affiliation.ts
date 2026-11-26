/** Publish one reviewed organization declaration for an exact saved inventory asset. */
import { redactCredentialText } from "../core/logger/redactor.ts";
import type { OperatorRunRef } from "../core/operator_runs.ts";
import { refreshSentinelAssessment } from "../sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../sentinel/cases.ts";
import { readSentinelChatSnapshot } from "../sentinel/chat_mode.ts";
import { loadSentinelGraph } from "../sentinel/graph.ts";
import { openSentinelInventoryPublicationReceipts } from "../sentinel/inventory_publication_receipts.ts";
import { publishSentinelInput } from "../sentinel/published_input.ts";
import {
  digestSentinelSnapshot,
  retainSentinelSourceSnapshot,
} from "../sentinel/shared_inventory.ts";
import {
  assertOperatorSourceSnapshot,
  withSentinelSourceSnapshotLock,
} from "../sentinel/source_snapshot_lock.ts";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const unavailable =
  "Error: The exact Sentinel inventory affiliation is unavailable.";

interface AffiliationBinding {
  readonly sourceCaseId: string;
  readonly assetId: string;
  readonly organizationId: string;
  readonly evidenceId: string;
  readonly reason: string;
}

interface AffiliationRequest extends AffiliationBinding {
  readonly requestId: string;
  readonly previousDigest: string;
  readonly nextDigest: string;
}

function cleanText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim() === value && !!value &&
    value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value) &&
    redactCredentialText(value) === value;
}

export async function executeOperatorInventoryAffiliation(
  baseDir: string,
  ref: OperatorRunRef,
  args: Record<string, unknown>,
  confirm: (message: string) => Promise<boolean>,
  reauthorize: () => Promise<boolean>,
  webContainmentConfigured?: boolean,
): Promise<Record<string, unknown> | string> {
  const applying = args.action === "affiliate_inventory_asset";
  const { assetId, organizationId, evidenceId, note } = args;
  if (
    ref.kind !== "sentinel" || ref.revision !== undefined ||
    !cleanText(assetId, 800) || !cleanText(organizationId, 256) ||
    !cleanText(evidenceId, 800) || !cleanText(note, 512) ||
    Object.keys(args).some((key) =>
      ![
        "action",
        "kind",
        "id",
        "assetId",
        "organizationId",
        "evidenceId",
        "note",
        ...(applying ? ["requestId", "previewDigest"] : []),
      ].includes(key)
    )
  ) return unavailable;
  const selection: AffiliationBinding = {
    sourceCaseId: ref.id,
    assetId,
    organizationId,
    evidenceId,
    reason: note,
  };
  const path = resolveSentinelCasePath(baseDir, ref.id);
  const read = async () => {
    await assertOperatorSourceSnapshot(path);
    return loadSentinelGraph(await readSentinelChatSnapshot(path)).snapshot();
  };
  const proposal = async () => {
    const original = await read();
    const asset = original.nodes.find((node) => node.id === assetId);
    const evidence = original.nodes.find((node) => node.id === evidenceId);
    const orgs = original.nodes.flatMap((node) =>
      node.kind === "asset" && node.organization?.id === organizationId
        ? [node.organization]
        : []
    );
    if (
      asset?.kind !== "asset" || asset.organization ||
      evidence?.kind !== "evidence" ||
      !original.edges.some(({ from, to, relation }) =>
        from === evidenceId && to === assetId && relation === "observed_on"
      ) ||
      !orgs.length || orgs.some(({ label }) => label !== orgs[0].label) ||
      !cleanText(orgs[0].label, 256)
    ) return;
    const snapshot = {
      ...original,
      nodes: original.nodes.map((node) =>
        node.id === assetId ? { ...asset, organization: orgs[0] } : node
      ),
    };
    const preview = {
      ...selection,
      organizationLabel: orgs[0].label,
      previousDigest: digestSentinelSnapshot(original),
      nextDigest: digestSentinelSnapshot(snapshot),
    };
    return { original, snapshot, preview };
  };

  try {
    if (!applying) {
      const planned = await proposal();
      return planned ? { preview: planned.preview } : unavailable;
    }
    const { requestId, previewDigest } = args;
    if (
      typeof requestId !== "string" || !uuid.test(requestId) ||
      typeof previewDigest !== "string" || !digest.test(previewDigest)
    ) return unavailable;
    const id = requestId.toLowerCase();
    const receipts = openSentinelInventoryPublicationReceipts<
      AffiliationRequest
    >(
      baseDir,
      "affiliation",
      (value) => value,
    );
    const replay = () => {
      const prior = receipts.read(id);
      if (!prior) return undefined;
      return prior.previousDigest === previewDigest &&
          prior.sourceCaseId === selection.sourceCaseId &&
          prior.assetId === assetId &&
          prior.organizationId === organizationId &&
          prior.evidenceId === evidenceId && prior.reason === note
        ? prior
        : unavailable;
    };
    const refresh = () => {
      try {
        refreshSentinelAssessment(path, webContainmentConfigured);
      } catch {
        // Background refresh can ingest the already-committed snapshot.
      }
    };
    const reopen = async (
      prior: Exclude<NonNullable<ReturnType<typeof replay>>, string>,
    ) => {
      if (
        prior.status !== "pending" ||
        digestSentinelSnapshot(await read()) !== prior.nextDigest
      ) return { receipt: prior };
      const receipt = receipts.reconcilePublished({
        ...selection,
        requestId: id,
        previousDigest: previewDigest,
        nextDigest: prior.nextDigest,
      });
      if (receipt) refresh();
      return { receipt: receipt ?? prior };
    };
    try {
      let prior = replay();
      if (prior !== undefined) {
        if (typeof prior === "string") return prior;
        const saved = prior;
        return saved.status === "pending"
          ? await withSentinelSourceSnapshotLock(
            baseDir,
            true,
            () => reopen(saved),
          )
          : { receipt: saved };
      }
      const planned = await proposal();
      if (!planned || planned.preview.previousDigest !== previewDigest) {
        return unavailable;
      }
      if (
        !await confirm(
          `Approve this exact Sentinel inventory affiliation?\n${
            JSON.stringify(planned.preview)
          }`,
        )
      ) return "Error: The operator declined the run action.";
      return await withSentinelSourceSnapshotLock(baseDir, true, async () => {
        prior = replay();
        if (prior !== undefined) {
          return typeof prior === "string" ? prior : await reopen(prior);
        }
        if (!await reauthorize()) return unavailable;
        const current = await proposal();
        if (
          !current || current.preview.previousDigest !== previewDigest ||
          current.preview.nextDigest !== planned.preview.nextDigest
        ) return unavailable;
        const request = {
          ...selection,
          requestId: id,
          previousDigest: previewDigest,
          nextDigest: current.preview.nextDigest,
        };
        const admitted = receipts.admit(request);
        if (!admitted) return unavailable;
        if (!admitted.admitted) return { receipt: admitted.receipt };
        let status: "succeeded" | "failed" = "failed";
        try {
          await retainSentinelSourceSnapshot(
            baseDir,
            ref.id,
            previewDigest,
            current.original,
          );
          if (digestSentinelSnapshot(await read()) === previewDigest) {
            await publishSentinelInput(path, current.snapshot);
            status = "succeeded";
          }
        } catch {
          // The durable outcome carries no raw source data or filesystem error.
        }
        const receipt = receipts.complete(request, admitted.token, status);
        if (status === "succeeded") refresh();
        return receipt ? { receipt } : unavailable;
      });
    } finally {
      receipts.close();
    }
  } catch {
    return unavailable;
  }
}
