/**
 * Triggerfish YAML configuration type definitions.
 *
 * Contains the TriggerFishConfig interface and local Result type aliases
 * used by the config module.
 *
 * @module
 */

import type { ModelProfileAllowlists } from "./model_profile_selection.ts";
import type { DelegatedGoalConfig } from "./delegated_goal_config.ts";

export const sentinelOutputLanguages = ["en", "es", "ko", "zh", "ja"] as const;
export type SentinelOutputLanguage = typeof sentinelOutputLanguages[number];

/** Server-derived source identity for a scheduled occurrence. */
export interface ScheduledObservationSource {
  readonly kind: "cron" | "trigger" | "webhook";
  readonly sourceId: string;
}

/** Exact coordinates of a committed Sentinel observation. */
export interface SentinelObservationReference {
  readonly case: string;
  readonly run_id: string;
  readonly revision: number;
  readonly observation_id: string;
}

export interface SentinelDelegatedObservationRead
  extends SentinelObservationReference {
  readonly parent_session_id: string;
  readonly execution_id: string;
}

export interface DelegatedObservationSource {
  readonly parentSessionId: string;
  readonly executionId: string;
}

/** Grant one exact observation to one authenticated team delivery. */
export interface SentinelTeamObservationRead
  extends SentinelObservationReference {
  readonly owner_session_id: string;
  readonly team_id: string;
  readonly member_session_id: string;
  readonly delivery_id: string;
}

export interface TeamObservationSource {
  readonly ownerSessionId: string;
  readonly teamId: string;
  readonly memberSessionId: string;
  readonly deliveryId: string;
}

/** Exact committed Sentinel observation an explicitly granted source may read. */
export type SentinelScheduledObservationRead =
  & SentinelObservationReference
  & (
    | {
      readonly cron_job_id: string;
      readonly trigger?: never;
      readonly webhook_source_id?: never;
    }
    | {
      readonly trigger: true;
      readonly cron_job_id?: never;
      readonly webhook_source_id?: never;
    }
    | {
      readonly webhook_source_id: string;
      readonly cron_job_id?: never;
      readonly trigger?: never;
    }
  );

const observationUuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

/** Read the single source selector from one configured grant. */
export function scheduledObservationGrantSource(
  grant: SentinelScheduledObservationRead,
): ScheduledObservationSource | undefined {
  if (!grant || typeof grant !== "object" || Array.isArray(grant)) return;
  const { cron_job_id, trigger, webhook_source_id } = grant;
  if (
    [cron_job_id, trigger, webhook_source_id].filter((value) =>
      value !== undefined
    ).length !== 1
  ) return;
  if (typeof cron_job_id === "string" && observationUuid.test(cron_job_id)) {
    return { kind: "cron", sourceId: cron_job_id };
  }
  if (trigger === true) return { kind: "trigger", sourceId: "trigger" };
  if (
    typeof webhook_source_id === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(webhook_source_id)
  ) {
    return { kind: "webhook", sourceId: webhook_source_id };
  }
}

/** Require one unambiguous grant bound to a trusted scheduled source. */
export function selectSentinelScheduledObservationRead(
  grants: readonly SentinelScheduledObservationRead[] | undefined,
  source: ScheduledObservationSource | string | undefined,
): SentinelScheduledObservationRead | undefined {
  const selected = typeof source === "string"
    ? { kind: "cron", sourceId: source }
    : source;
  if (!selected || !Array.isArray(grants)) return;
  const matching = grants.filter((grant) => {
    const candidate = scheduledObservationGrantSource(grant);
    return candidate?.kind === selected.kind &&
      candidate.sourceId === selected.sourceId;
  });
  if (matching.length !== 1) return;
  const [grant] = matching;
  return validSentinelObservationReference(grant) ? grant : undefined;
}

/** Bind one exact grant to the authenticated parent and admitted execution. */
export function selectSentinelDelegatedObservationRead(
  grants: readonly SentinelDelegatedObservationRead[] | undefined,
  source: DelegatedObservationSource | undefined,
): SentinelDelegatedObservationRead | undefined {
  if (
    !source || !Array.isArray(grants) ||
    !observationUuid.test(source.parentSessionId) ||
    !observationUuid.test(source.executionId)
  ) return;
  const matching = grants.filter((grant) =>
    grant?.parent_session_id === source.parentSessionId &&
    grant?.execution_id === source.executionId
  );
  return matching.length === 1 && validSentinelObservationReference(matching[0])
    ? matching[0]
    : undefined;
}

export function selectSentinelTeamObservationRead(
  grants: readonly SentinelTeamObservationRead[] | undefined,
  source: TeamObservationSource | undefined,
): SentinelTeamObservationRead | undefined {
  if (!source || !Array.isArray(grants)) return;
  const { ownerSessionId, teamId, memberSessionId, deliveryId } = source;
  if (
    ![ownerSessionId, teamId, memberSessionId, deliveryId].every(
      (id) => typeof id === "string" && observationUuid.test(id),
    )
  ) return;
  const matching = grants.filter((grant) =>
    grant?.owner_session_id === ownerSessionId &&
    grant?.team_id === teamId &&
    grant?.member_session_id === memberSessionId &&
    grant?.delivery_id === deliveryId
  );
  return matching.length === 1 && validSentinelObservationReference(matching[0])
    ? matching[0]
    : undefined;
}

/** Identify the journal that backs a committed local evidence grant. */
export function sentinelLocalObservationKind(id: string) {
  if (/^worker-graph-fact:[a-f0-9]{64}$/.test(id)) return "graph_fact";
  if (/^worker-finding:[a-f0-9]{64}$/.test(id)) return "finding";
  if (/^worker-recheck:[a-f0-9]{64}$/.test(id)) return "finding_recheck";
}

function validSentinelObservationReference(
  grant: SentinelObservationReference,
): boolean {
  return !(
    typeof grant.case !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(grant.case) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(grant.case) ||
    typeof grant.run_id !== "string" || !observationUuid.test(grant.run_id) ||
    !Number.isSafeInteger(grant.revision) || grant.revision < 1 ||
    typeof grant.observation_id !== "string" ||
    !(/^workflow-observation:[a-f0-9]{64}$/.test(grant.observation_id) ||
      sentinelLocalObservationKind(grant.observation_id))
  );
}

/** Generic plugin configuration entry for dynamically loaded plugins. */
export interface PluginConfigEntry {
  readonly enabled?: boolean;
  readonly classification?: string;
  readonly trust?: "sandboxed" | "trusted";
  readonly [key: string]: unknown;
}

/** Triggerfish YAML configuration shape. */
interface WorkflowEvidenceScope {
  readonly case: string;
  readonly run_id: string;
  readonly revision: number;
}

export type WorkflowEvidenceRequirement =
  & WorkflowEvidenceScope
  & (
    | { readonly observation_id: string; readonly workflow_run_id: number }
    | { readonly graph_fact_id: string; readonly require_current_pass?: true }
    | { readonly finding_recheck_id: string }
    | { readonly finding_id: string }
    | {
      readonly asset_id: string;
      readonly control_id: string;
      readonly require_current_pass: true;
    }
  );

/** Persisted settings for one configured MCP server. */
export interface ConfiguredMcpServer {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly classification?: string;
  readonly enabled?: boolean;
  readonly tool_call_timeout_ms?: number;
  readonly max_retries?: number;
}

export const MAX_SENTINEL_ASSESSMENT_CONCURRENCY = 12;

export interface TriggerFishConfig {
  readonly tool_approval?: readonly string[];
  readonly operator_workflows?: readonly {
    readonly id: string;
    readonly classification: "PUBLIC" | "INTERNAL";
    readonly steps: readonly {
      readonly id: string;
      readonly waitSeconds?: number;
      readonly satisfiedBy?: WorkflowEvidenceRequirement;
      readonly evidenceWaitSeconds?: number;
    }[];
  }[];
  readonly delegated_goal_completion?: readonly DelegatedGoalConfig[];
  readonly agent_recovery?: {
    readonly owner_checklists?: boolean;
    readonly background_checklists?: boolean;
    readonly github_repositories?: readonly string[];
    readonly sentinel_assignment_cases?: readonly string[];
    readonly github_repository_status?: boolean;
    readonly github_pull_status?: boolean;
    readonly github_run_status?: boolean;
    readonly github_cancel_runs?: readonly {
      readonly repo: string;
      readonly repository_id: number;
      readonly run_id: number;
      readonly attempt: number;
    }[];
    readonly github_release_status?: boolean;
    readonly github_branch_protection?: boolean;
    readonly github_branch_names?: Readonly<Record<string, readonly string[]>>;
    readonly scheduler?: boolean;
    readonly team?: boolean;
  };
  readonly models: {
    readonly primary: {
      readonly provider: string;
      /** Optional when provider is "triggerfish" — the Gateway selects models internally. */
      readonly model?: string;
    };
    readonly vision?: string;
    readonly providers: Readonly<
      Record<string, { readonly model: string; readonly apiKey?: string }>
    >;
    /**
     * Optional per-classification-level model overrides.
     * When present, LLM calls at the specified taint level use the
     * referenced provider+model instead of `primary`. Unlisted levels
     * fall back to `primary`. Each referenced provider must exist in
     * the `providers` block.
     */
    readonly classification_models?: Readonly<
      Partial<
        Record<string, { readonly provider: string; readonly model: string }>
      >
    >;
  };
  readonly channels: Readonly<Record<string, unknown>>;
  readonly classification: {
    readonly mode: string;
  };
  readonly sentinel?: {
    readonly allow_model_access?: boolean;
    readonly notify_incident_increases?: boolean;
    readonly output_language?: SentinelOutputLanguage;
    readonly model_worker_limit?: number;
    readonly assessment_concurrency?: number;
    readonly planner_heartbeat_seconds?: number;
    readonly model_profile_allowlists?: ModelProfileAllowlists;
    readonly capture_origins?: readonly string[];
    readonly scheduled_observation_reads?:
      readonly SentinelScheduledObservationRead[];
    readonly team_observation_reads?: readonly SentinelTeamObservationRead[];
    readonly delegated_observation_reads?:
      readonly SentinelDelegatedObservationRead[];
    readonly github_workflow_reads?: readonly {
      readonly case: string;
      readonly asset: string;
      readonly owner: string;
      readonly repo: string;
      readonly workflow_id: number;
    }[];
  };
  readonly web?: {
    readonly search?: {
      readonly provider?: string;
      readonly api_key?: string;
      readonly max_results?: number;
      readonly safe_search?: string;
      readonly rate_limit?: number;
    };
    readonly fetch?: {
      readonly rate_limit?: number;
      readonly max_content_length?: number;
      readonly timeout?: number;
      readonly default_mode?: string;
    };
    readonly domains?: {
      readonly sentinel_containment?: boolean;
      readonly denylist?: readonly string[];
      readonly allowlist?: readonly string[];
      readonly classifications?: readonly {
        readonly pattern: string;
        readonly classification: string;
      }[];
    };
  };
  readonly google?: {
    readonly classification?: string;
  };
  readonly github?: {
    readonly token?: string;
    readonly base_url?: string;
    readonly classification?: string;
    readonly classification_overrides?: Readonly<Record<string, string>>;
  };
  readonly notion?: {
    readonly enabled?: boolean;
    readonly auth_type?: "token" | "oauth2";
    readonly rate_limit?: number;
    readonly classification_floor?: string;
    readonly oauth2?: {
      readonly client_id?: string;
      readonly redirect_uri?: string;
    };
  };
  readonly x?: {
    readonly enabled?: boolean;
    readonly tier?: "free" | "basic" | "pro" | "pay_per_use";
    readonly classification?: string;
    readonly oauth?: {
      readonly client_id?: string;
      readonly redirect_uri?: string;
    };
    readonly quota?: {
      readonly log_warning_ratio?: number;
      readonly response_warning_ratio?: number;
    };
  };
  readonly caldav?: {
    readonly enabled?: boolean;
    readonly server_url?: string;
    readonly username?: string;
    readonly credential_ref?: string;
    readonly default_calendar?: string;
    readonly classification?: string;
  };
  readonly scheduler?: {
    readonly goal_completion?: readonly {
      readonly scope: string;
      readonly goal: string;
      readonly policy: "automatic" | "operator";
      readonly criteria: readonly {
        readonly id: string;
        readonly description: string;
        readonly kind: "cron" | "trigger" | "webhook";
        readonly source_id: string;
        readonly tool: string;
        readonly result_sha256: string;
      }[];
    }[];
    readonly trigger?: {
      readonly enabled?: boolean;
      readonly interval_minutes?: number;
      readonly quiet_hours?: {
        readonly start?: number;
        readonly end?: number;
      };
      /**
       * Classification ceiling for trigger sessions.
       * Integration tools classified above this level are blocked.
       * Defaults to "CONFIDENTIAL" when not set — triggers routinely need
       * access to CONFIDENTIAL integrations such as Gmail.
       * Set to "INTERNAL" explicitly to restrict trigger access.
       */
      readonly classification_ceiling?: string;
    };
    readonly webhooks?: {
      readonly enabled?: boolean;
      readonly sources?: Readonly<
        Record<string, {
          readonly secret: string;
          readonly classification: string;
          /** Explicit legacy opt-in; body-only signatures do not authenticate freshness. */
          readonly allow_body_signature?: boolean;
        }>
      >;
      /**
       * Maximum age of a webhook request in ms. Requests with missing or
       * older timestamps are rejected. Set to 0 to disable.
       * Default: 300_000 (5 minutes).
       */
      readonly max_age_ms?: number;
      /** Max signatures retained in the replay guard. Default: 10_000. */
      readonly replay_guard_size?: number;
    };
  };
  readonly plugins?: Readonly<Record<string, PluginConfigEntry>> & {
    readonly obsidian?: {
      readonly enabled?: boolean;
      readonly vault_path?: string;
      readonly classification?: string;
      readonly daily_notes?: {
        readonly folder?: string;
        readonly date_format?: string;
        readonly template?: string;
      };
      readonly exclude_folders?: readonly string[];
      readonly folder_classifications?: Readonly<Record<string, string>>;
    };
  };
  readonly secrets?: {
    readonly classification?: {
      /** Fallback classification when no mapping matches. Default: INTERNAL. */
      readonly default_level?: string;
      /** Ordered path-to-classification mappings. First match wins. */
      readonly mappings?: readonly {
        readonly path: string;
        readonly level: string;
      }[];
    };
  };
  readonly filesystem?: {
    readonly default?: string;
    readonly paths?: Readonly<Record<string, string>>;
  };
  readonly tools?: {
    readonly floors?: Readonly<Record<string, string>>;
  };
  readonly mcp_servers?: Readonly<Record<string, ConfiguredMcpServer>>;
  /** MCP servers (preferred path: mcp.servers). */
  readonly mcp?: {
    readonly servers?: Readonly<Record<string, ConfiguredMcpServer>>;
  };
  readonly logging?: {
    /** Log level: "quiet" | "normal" | "verbose" | "debug". Default: "normal". */
    readonly level?: string;
  };
  readonly daemon?: {
    /** Auto-approve daemon restarts triggered by config_manage. Default: false. */
    readonly auto_approve_restart?: boolean;
  };
  readonly debug?: boolean;
}

/** Success result. */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

/** Failure result. */
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/** Discriminated union result type. */
export type Result<T, E> = Ok<T> | Err<E>;
