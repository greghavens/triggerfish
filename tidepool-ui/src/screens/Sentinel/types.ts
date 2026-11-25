export interface SentinelPeerFindingCitation {
  readonly localAssetId: string;
  readonly sourceCaseId: string;
  readonly sourceAssetId: string;
  readonly sourceFindingId: string;
  readonly snapshotDigest: string;
}

interface SentinelPlannerRound {
  readonly recheckFindingId?: string;
  readonly identity: string;
  readonly attempt: number;
  readonly hintId?: number;
  readonly sourceKind?: "worker_result" | "model_review";
  readonly upstreamCheckId?: string;
  readonly upstreamCitations?: readonly { alertId: string; checkId: string }[];
  readonly peerFindingCitations?: readonly SentinelPeerFindingCitation[];
}

export interface SentinelRecheckLineage {
  readonly taskId: string;
  readonly evidenceRevision: number;
  readonly evidenceId: string;
  readonly finding: {
    readonly id: string;
    readonly title: string;
    readonly summary: string;
    readonly evidenceId: string;
    readonly evidenceRevision: number;
  };
  readonly rechecks: readonly {
    readonly id: string;
    readonly outcome: "pass" | "fail";
    readonly summary: string;
    readonly evidenceId: string;
  }[];
}

interface DecisionHold {
  readonly kind: "finding" | "incident";
  readonly id: number;
  readonly revision: number;
  readonly disposition: "resolved" | "dismissed";
}

export interface SentinelNode {
  readonly id: string;
  readonly label: string;
  readonly kind:
    | "asset"
    | "finding"
    | "control"
    | "evidence"
    | "goal"
    | "task"
    | "observation";
  readonly severity?: string;
  readonly sourceId?: string;
  readonly aliases?: readonly string[];
  readonly relationshipSources?: readonly {
    readonly caseId: string;
    readonly from: string;
    readonly to: string;
    readonly snapshotDigest?: string;
  }[];
  readonly origin?: string;
  readonly status?: string;
  readonly worker?: string;
  readonly reason?: string;
  readonly plannerRound?: SentinelPlannerRound;
  readonly peerFinding?: SentinelPeerFindingCitation;
  readonly assetDiscovery?: {
    readonly id: string;
    readonly sourceCaseId: string;
    readonly taskId: string;
    readonly evidenceRevision: number;
    readonly sourceDigest: string;
    readonly status: "approved" | "withdrawn";
    readonly claim: { readonly kind: string; readonly assetId: string; readonly evidenceId: string };
  };
  readonly factSatisfaction?: {
    readonly sourceTaskId: string;
    readonly sourceObservationSha256: string;
  };
  readonly workflowObservation?: {
    readonly id: string;
    readonly taskId: string;
    readonly targetId: string;
    readonly evidenceRevision: number;
    readonly stepIndex: number;
  };
  readonly githubWorkflowRead?: {
    readonly repository: string;
    readonly workflowId: number;
    readonly observedAt: string;
    readonly evidenceRevision: number;
    readonly resultSha256: string;
    readonly runs: readonly {
      readonly id: number;
      readonly status: string;
      readonly conclusion: string | null;
    }[];
  };
  readonly decisionHold?: DecisionHold;
  readonly alert?: SentinelAlert;
  readonly incident?: {
    readonly severity?: string;
    readonly asset: string;
    readonly startedAt: string;
    readonly endedAt: string;
    readonly signals: readonly string[];
    readonly reportedAssets: readonly string[];
    readonly evidenceIds: readonly string[];
    readonly findingIds: readonly string[];
    readonly alertCount?: number;
  };
  readonly findingReviews?: readonly FindingReview[];
  readonly incidentReview?: {
    readonly revision: number;
    readonly note: string;
    readonly at: string;
  };
  readonly modelReview?: {
    readonly taskId: string;
    readonly summary: string;
    readonly at: string;
    readonly steps: readonly {
      readonly tool: string;
      readonly target?: string;
      readonly outcome: string;
      readonly targetRef?: string;
      readonly aliasMapping?: SentinelAliasMapping;
      readonly sourceSnapshots?: readonly {
        readonly caseId: string;
        readonly assetId?: string;
        readonly snapshotDigest: string;
      }[];
    }[];
  };
}

export interface IncidentReview {
  readonly id: number;
  readonly incidentId: string;
  readonly revision: number;
  readonly disposition: string;
  readonly note: string;
  readonly at: string;
}

export interface FindingReview {
  readonly id: number;
  readonly findingId: string;
  readonly revision: number;
  readonly disposition: string;
  readonly note: string;
  readonly at: string;
}

export interface DecisionHistoryPage {
  readonly revision: number;
  readonly kind: "finding" | "incident";
  readonly subjectId: string;
  readonly before?: number;
  readonly decisions: readonly Omit<FindingReview, "findingId">[];
  readonly nextBefore: number | null;
}

export interface SentinelAlert {
  readonly type: string;
  readonly severity: string;
  readonly asset: string;
  readonly subject: string;
  readonly observedAt: string;
  readonly evidenceIds: readonly string[];
  readonly triggeringAction?: string;
  readonly entraRoleGrant?: {
    readonly roleIds: readonly string[];
    readonly administrativeUnitIds: readonly string[];
    readonly modifiedRoleIds?: readonly string[];
    readonly modifiedRoleTemplateIds?: readonly string[];
  };
}

export interface SentinelEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: string;
}

export interface SentinelPathExport {
  readonly from: string;
  readonly to: string;
  readonly direction: string;
  readonly relation: string | null;
  readonly relations: readonly string[];
  readonly maxDepth: number;
  readonly nodes: readonly SentinelNode[];
  readonly edges: readonly SentinelEdge[];
}

export interface SentinelAliasMapping {
  readonly proof: string;
  readonly sources: readonly { readonly caseId: string; readonly snapshotDigest: string }[];
}

export interface SentinelGraph {
  readonly nodes: readonly SentinelNode[];
  readonly edges: readonly SentinelEdge[];
  readonly unresolvedReferences?: readonly {
    readonly node: string;
    readonly reference: string;
    readonly relation: string;
  }[];
}

export interface SentinelTask {
  readonly id: string;
  readonly worker?: string;
  readonly kind?: string;
  readonly nodeId?: string;
  readonly evidenceIds?: readonly string[];
  readonly attempts?: number;
  readonly depth?: number;
  readonly observation?: unknown;
  readonly retryable?: boolean;
  readonly prioritized?: boolean;
  readonly plannerPriority?: number;
  readonly retirementReason?: string;
  readonly heldForDecision?: boolean;
  readonly dependencyRecommendation?: {
    readonly id: string;
    readonly prerequisites: readonly string[];
    readonly reason: string;
    readonly queueOnly?: boolean;
    readonly queueChanges?: {
      readonly priorities?: readonly string[];
      readonly retirements?: readonly { id: string; reason: string }[];
    };
    readonly citations?: readonly {
      id: string;
      evidenceIds: readonly string[];
      plannerRound?: SentinelPlannerRound;
    }[];
    readonly additions?: readonly { id: string; kind: string; nodeId?: string; prerequisites: readonly string[] }[];
  };
  readonly label?: string;
  readonly status: string;
  readonly requiredInput?: string;
  readonly reason?: string;
  readonly plannerRound?: SentinelPlannerRound;
  readonly decisionHold?: DecisionHold;
  readonly prerequisites?: readonly string[];
  readonly reviewedFrom?: string;
}

export interface SentinelReview {
  readonly task: string;
  readonly analysis: string;
  readonly steps?: readonly { tool: string; target?: string; outcome: string; aliasMapping?: SentinelAliasMapping }[];
}

export interface SentinelObservation {
  readonly id: string;
  readonly task: string;
  readonly worker: string;
  readonly facts: Readonly<Record<string, unknown>>;
}

export interface SentinelAssessment {
  readonly active: boolean;
  readonly paused?: boolean;
  readonly plan?: { readonly goal?: string };
  readonly revision: number;
  readonly updatedAt: string;
  readonly completion?: { goal: string | null; note: string; at: string };
  readonly result: {
    readonly tasks: readonly SentinelTask[];
    readonly sharedGraph: {
      readonly snapshot: SentinelGraph | null;
      readonly observations: readonly SentinelObservation[];
    };
  } | null;
  readonly reviews: readonly SentinelReview[];
}

export interface SentinelModelUsage {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface SentinelAdaptive {
  readonly modelReviews?: readonly { readonly taskId: string }[];
  readonly modelReviewStates?: readonly {
    readonly taskId: string;
    readonly attempts: number;
    readonly status: string;
    readonly retryable: boolean;
  }[];
  readonly modelUsage?: SentinelModelUsage;
  readonly taskLimit?: number;
  readonly revision?: string;
  readonly goal?: { readonly id: string; readonly label: string };
  readonly tasks?: readonly SentinelTask[];
  readonly modelPlanner?: {
    readonly status: "running" | "completed" | "retry_pending" | "exhausted" | "superseded" | "no_new_assignments" | "proposal_rejected";
    readonly attempt: number;
  } | null;
  readonly modelPlannerHistory?: readonly {
    readonly identity?: string;
    readonly hintIds?: readonly number[];
    readonly findingReviewIds?: readonly number[];
    readonly incidentReviewIds?: readonly number[];
    readonly incidentCandidateIds?: readonly string[];
    readonly findingReviewId?: number;
    readonly incidentReviewId?: number;
    readonly attempt: number;
    readonly hintId?: number;
    readonly started: string;
    readonly finished: string | null;
    readonly reads?: readonly { readonly tool: string; readonly aliasMapping?: SentinelAliasMapping }[];
    readonly outcome: string;
  }[];
  readonly historyCursor?: number | null;
  readonly history?: readonly {
    readonly revision?: string;
    readonly taskId: string;
    readonly kind?: string;
    readonly nodeId?: string;
    readonly event: string;
    readonly removedEvidenceIds?: readonly string[];
    readonly attempt: number;
    readonly at: string;
    readonly note: string | null;
  }[];
  readonly notes?: readonly {
    readonly revision?: string;
    readonly taskId: string | null;
    readonly kind?: string;
    readonly nodeId?: string;
    readonly note: string;
    readonly steps?: SentinelReview["steps"];
    readonly at: string;
  }[];
}

/** Display protocol identifiers as labels without changing their source values. */
export function humanize(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

export interface SentinelInventoryImport {
  readonly mode: "merge" | "replace";
  readonly format: "graph" | "sarif" | "cyclonedx" | "spdx" | "har" | "osv";
  readonly source?: string;
  readonly content: string;
  readonly inventoryDigest?: string | null;
}

type ImportPreviewRecord = Pick<SentinelNode, "id" | "label" | "kind" | "severity">;

export interface SentinelImportPreview {
  readonly inventoryDigest: string | null;
  readonly currentNodes: number;
  readonly currentEdges: number;
  readonly resultingNodes: number;
  readonly resultingEdges: number;
  readonly addedNodes: number;
  readonly changedNodes: number;
  readonly addedEdges: number;
  readonly removedEdges: number;
  readonly removedNodes: number;
  readonly records?: {
    readonly added: readonly ImportPreviewRecord[];
    readonly removed: readonly ImportPreviewRecord[];
    readonly changed: readonly { before: ImportPreviewRecord; after: ImportPreviewRecord; fields: readonly string[] }[];
  };
  readonly relationships?: {
    readonly added: readonly SentinelEdge[];
    readonly removed: readonly SentinelEdge[];
  };
}

export function planningInputs(attempt: NonNullable<SentinelAdaptive["modelPlannerHistory"]>[number]) {
  return [
    { kind: "hint", label: "Case hint", ids: attempt.hintIds ?? (attempt.hintId ? [attempt.hintId] : []) },
    { kind: "finding", label: "Finding decision", ids: attempt.findingReviewIds ?? (attempt.findingReviewId ? [attempt.findingReviewId] : []) },
    { kind: "incident", label: "Incident decision", ids: attempt.incidentReviewIds ?? (attempt.incidentReviewId ? [attempt.incidentReviewId] : []) },
  ] as const;
}
