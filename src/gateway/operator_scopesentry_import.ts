/** Review and publish a bounded selection from an existing classified inventory connector. */
import type { OperatorRunRef } from "../core/operator_runs.ts";
import {
  canFlowTo,
  type ClassificationLevel,
} from "../core/types/classification.ts";
import { assetText } from "../sentinel/asset_properties.ts";
import {
  readSentinelAssessment,
  readSentinelOperatingConstraints,
  readSentinelRunIdForRevision,
  refreshSentinelAssessment,
} from "../sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../sentinel/cases.ts";
import { readSentinelChatSnapshot } from "../sentinel/chat_mode.ts";
import { loadSentinelGraph } from "../sentinel/graph.ts";
import { openSentinelInventoryPublicationReceipts } from "../sentinel/inventory_publication_receipts.ts";
import { publishSentinelInput } from "../sentinel/published_input.ts";
import {
  scopeSentryKinds,
  stageScopeSentryInventory,
} from "../sentinel/scopesentry_inventory.ts";
import { sentinelScopeMatcher } from "../sentinel/scope_rules.ts";
import {
  digestSentinelSnapshot,
  retainSentinelSourceSnapshot,
} from "../sentinel/shared_inventory.ts";
import {
  assertOperatorSourceSnapshot,
  withSentinelSourceSnapshotLock,
} from "../sentinel/source_snapshot_lock.ts";
import type { OperatorRunToolContext } from "./operator_run_tool.ts";

const tool = "mcp_scopesentry_list_assets";
const projectTool = "mcp_scopesentry_list_projects_data";
const taskTool = "mcp_scopesentry_list_tasks";
export const inventoryConnectorTools = [tool, projectTool, taskTool] as const;
const unavailable =
  "Error: The selected inventory source or current case scope is unavailable.";
const declined = "Error: The operator declined the run action.";

export interface ScopeSentryConnector {
  readonly lookup: () => {
    readonly classification?: ClassificationLevel;
    readonly tools: readonly string[];
  } | undefined;
  readonly execute: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<string | null>;
}

export async function listOperatorScopeSentrySources(
  baseDir: string,
  ref: OperatorRunRef,
  args: Record<string, unknown>,
  connector: ScopeSentryConnector | undefined,
  context: OperatorRunToolContext | undefined,
) {
  const { sourceDimension, page = 1, query } = args;
  const authorize = context?.authorizeOwnerRunCall;
  const name = sourceDimension === "project" ? projectTool : taskTool;
  const search = assetText(query, 120);
  const revision = ref.revision;
  if (
    !connector || !context?.authenticatedOwnerSessionId || !authorize ||
    !context.authorizeInventoryConnectorCall ||
    ref.kind !== "sentinel" || revision === undefined ||
    (sourceDimension !== "project" && sourceDimension !== "task") ||
    (query !== undefined && !search) ||
    typeof page !== "number" || !Number.isSafeInteger(page) || page < 1 ||
    page > 1000 ||
    Object.keys(args).some((key) =>
      !["action", "kind", "id", "revision", "sourceDimension", "page", "query"]
        .includes(key)
    ) ||
    !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC")
  ) return unavailable;
  const path = resolveSentinelCasePath(baseDir, ref.id);
  const runId = readSentinelRunIdForRevision(path, revision);
  const classification = connector.lookup()?.classification;
  if (
    !runId || (classification !== "INTERNAL" && classification !== "PUBLIC") ||
    !canFlowTo(context.inputClassification ?? "PUBLIC", classification)
  ) return unavailable;
  const current = async () => {
    if (!await authorize(args)) return false;
    const live = connector.lookup();
    return live?.classification === classification &&
      live.tools.includes(name) &&
      readSentinelAssessment(path)?.revision === revision &&
      readSentinelRunIdForRevision(path, revision) === runId;
  };
  const call = { pageIndex: page, pageSize: 50, ...(search && { search }) };
  try {
    if (
      !await current() ||
      !await context.authorizeInventoryConnectorCall({ name, args: call }) ||
      !await current()
    ) return unavailable;
    const text = await connector.execute(name, call);
    if (
      !text || text.length > 500_000 || !await current() ||
      !await context.authorizeSavedResponse(name, text, classification) ||
      !await current()
    ) return unavailable;
    const data = JSON.parse(text);
    const rows = sourceDimension === "project" ? data?.result?.All : data?.list;
    if (!Array.isArray(rows) || rows.length > 50) return unavailable;
    const sources = new Map<string, { id: string; name: string }>();
    for (const row of rows) {
      const name = assetText(row?.name, 160);
      const id = sourceDimension === "project" ? row?.id : name;
      if (
        !name || typeof id !== "string" ||
        (sourceDimension === "project" && !/^[a-f\d]{24}$/i.test(id))
      ) continue;
      sources.set(id, { id, name });
    }
    return { sources: [...sources.values()], page };
  } catch {
    return unavailable;
  }
}

export async function executeOperatorScopeSentryImport(
  baseDir: string,
  ref: OperatorRunRef,
  args: Record<string, unknown>,
  connector: ScopeSentryConnector | undefined,
  context: OperatorRunToolContext | undefined,
  confirm: (message: string) => Promise<boolean>,
  webContainment?: boolean,
) {
  const dimension = args.sourceDimension;
  const sourceId = assetText(args.sourceSelection, 160);
  const page = args.page ?? 1;
  const pageCount = args.pageCount === undefined ? 1 : args.pageCount;
  const { requestId } = args;
  const revision = ref.revision;
  if (
    !context?.authenticatedOwnerSessionId || !context.authorizeOwnerRunCall ||
    !connector || ref.kind !== "sentinel" || revision === undefined ||
    (dimension !== "project" && dimension !== "task") || !sourceId ||
    (dimension === "project" && !/^[a-f\d]{24}$/i.test(sourceId)) ||
    typeof page !== "number" || !Number.isSafeInteger(page) || page < 1 ||
    page > 1000 ||
    typeof pageCount !== "number" || !Number.isSafeInteger(pageCount) ||
    pageCount < 1 || pageCount > 10 || page + pageCount - 1 > 1000 ||
    typeof requestId !== "string" ||
    !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(requestId) ||
    Object.keys(args).some((key) =>
      ![
        "action",
        "kind",
        "id",
        "revision",
        "sourceDimension",
        "sourceSelection",
        "page",
        "pageCount",
        "requestId",
      ].includes(key)
    ) ||
    !canFlowTo(context.inputClassification ?? "PUBLIC", "INTERNAL") ||
    !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC")
  ) return unavailable;
  const path = resolveSentinelCasePath(baseDir, ref.id);
  const runId = readSentinelRunIdForRevision(path, revision);
  if (!runId) return unavailable;
  const policy = readSentinelOperatingConstraints(path, runId);
  const selector = policy?.membership?.selector;
  if (
    !policy || selector?.kind !== "rules" || selector.organizationId ||
    !selector.rules.length
  ) {
    return unavailable;
  }
  const source = {
    dimension,
    sourceId,
    page,
    ...(pageCount > 1 && { pageCount }),
    caseId: ref.id,
    runId,
    revision,
    requestId,
  };
  const read = async () => {
    await assertOperatorSourceSnapshot(path);
    return loadSentinelGraph(await readSentinelChatSnapshot(path)).snapshot();
  };
  const exposed = () => {
    const live = connector.lookup();
    return live?.tools.includes(tool) &&
        (live.classification === "PUBLIC" || live.classification === "INTERNAL")
      ? live.classification
      : undefined;
  };
  const classification = exposed();
  const current = async () => {
    if (
      !classification ||
      !canFlowTo(context.inputClassification ?? "PUBLIC", classification) ||
      !await context.authorizeOwnerRunCall?.(args)
    ) {
      return false;
    }
    const current = readSentinelOperatingConstraints(path, runId);
    return exposed() === classification &&
      readSentinelAssessment(path)?.revision === revision &&
      readSentinelRunIdForRevision(path, revision) === runId &&
      current?.version === policy.version && current.digest === policy.digest;
  };
  const receipts = openSentinelInventoryPublicationReceipts<
    typeof source & {
      readonly previousDigest: string;
      readonly nextDigest: string;
    }
  >(baseDir, "scopesentry", (value) => value);
  const replay = () => {
    const saved = receipts.read(requestId);
    if (!saved) return;
    return Object.entries(source).every(([key, value]) =>
        saved[key as keyof typeof source] === value
      ) && saved.pageCount === source.pageCount
      ? saved
      : unavailable;
  };
  const refresh = () => {
    try {
      refreshSentinelAssessment(path, webContainment);
    } catch {
      // Gateway refresh can ingest the already-published inventory.
    }
  };
  try {
    const prior = replay();
    if (prior !== undefined) {
      if (
        typeof prior === "string" || !classification ||
        exposed() !== classification ||
        !await context.authorizeOwnerRunCall(args)
      ) return unavailable;
      if (prior.status !== "pending") return { receipt: prior };
      return await withSentinelSourceSnapshotLock(baseDir, true, async () => {
        if (!await context.authorizeOwnerRunCall?.(args)) return unavailable;
        if (digestSentinelSnapshot(await read()) !== prior.nextDigest) {
          return { receipt: prior };
        }
        const receipt = receipts.reconcilePublished({
          ...source,
          previousDigest: prior.previousDigest,
          nextDigest: prior.nextDigest,
        });
        if (receipt) refresh();
        return { receipt: receipt ?? prior };
      });
    }
    if (!classification || !await current()) return unavailable;
    const previous = await read();
    const previousDigest = digestSentinelSnapshot(previous);
    if (
      !await confirm(
        `Allow this exact retained inventory query?\n${JSON.stringify(source)}`,
      )
    ) return declined;
    const pages = [];
    for (const kind of scopeSentryKinds) {
      for (let pageIndex = page; pageIndex < page + pageCount; pageIndex++) {
        const query = {
          asset_type: kind,
          filter: { [dimension]: [sourceId] },
          pageIndex,
          pageSize: 100,
        };
        if (
          !await current() ||
          !await context.authorizeInventoryConnectorCall?.({
            name: tool,
            args: query,
          }) ||
          !await current()
        ) return unavailable;
        const text = await connector.execute(tool, query);
        if (
          !text || text.length > 500_000 || !await current() ||
          !await context.authorizeSavedResponse(tool, text, classification) ||
          !await current()
        ) return unavailable;
        const data = JSON.parse(text);
        if (!Array.isArray(data?.list) || data.list.length > query.pageSize) {
          return unavailable;
        }
        pages.push({ kind, page: pageIndex, text });
        if (data.list.length < query.pageSize) break;
      }
    }
    const staged = stageScopeSentryInventory(
      previous,
      pages,
      source,
      sentinelScopeMatcher(selector.rules),
    );
    if (!staged || !await current()) return unavailable;
    if (!staged.imported) return { imported: 0 };
    const nextDigest = digestSentinelSnapshot(staged.snapshot);
    const binding = { ...source, previousDigest, nextDigest };
    if (
      !await confirm(
        `Approve this exact in-scope inventory update?\n${
          JSON.stringify({
            ...binding,
            sourceRecords: staged.imported,
          })
        }`,
      )
    ) return declined;
    return await withSentinelSourceSnapshotLock(baseDir, true, async () => {
      if (!await current()) return unavailable;
      const saved = replay();
      if (saved !== undefined) {
        return typeof saved === "string" ? saved : { receipt: saved };
      }
      if (digestSentinelSnapshot(await read()) !== previousDigest) {
        return unavailable;
      }
      await retainSentinelSourceSnapshot(
        baseDir,
        ref.id,
        previousDigest,
        previous,
      );
      if (
        !await current() ||
        digestSentinelSnapshot(await read()) !== previousDigest
      ) return unavailable;
      const admitted = receipts.admit(binding);
      if (!admitted) return unavailable;
      if (!admitted.admitted) return { receipt: admitted.receipt };
      await publishSentinelInput(path, staged.snapshot);
      const receipt = receipts.complete(binding, admitted.token, "succeeded");
      if (receipt) refresh();
      return receipt ? { receipt, imported: staged.imported } : unavailable;
    });
  } catch {
    return unavailable;
  } finally {
    receipts.close();
  }
}
