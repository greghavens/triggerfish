/**
 * Triggerfish YAML configuration type definitions.
 *
 * Contains the TriggerFishConfig interface and local Result type aliases
 * used by the config module.
 *
 * @module
 */

/** Generic plugin configuration entry for dynamically loaded plugins. */
export interface PluginConfigEntry {
  readonly enabled?: boolean;
  readonly classification?: string;
  readonly trust?: "sandboxed" | "trusted";
  readonly [key: string]: unknown;
}

/** Triggerfish YAML configuration shape. */
export interface TriggerFishConfig {
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
        }>
      >;
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
  readonly mcp_servers?: Readonly<
    Record<string, {
      readonly command?: string;
      readonly args?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
      readonly url?: string;
      readonly classification?: string;
      readonly enabled?: boolean;
    }>
  >;
  /** MCP servers (preferred path: mcp.servers). */
  readonly mcp?: {
    readonly servers?: Readonly<
      Record<string, {
        readonly command?: string;
        readonly args?: readonly string[];
        readonly env?: Readonly<Record<string, string>>;
        readonly url?: string;
        readonly classification?: string;
        readonly enabled?: boolean;
      }>
    >;
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
