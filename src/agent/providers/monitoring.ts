import { parseClassification } from "../../core/types/classification.ts";
import { type ModelCallScope, modelMonitor } from "../../core/model_monitor.ts";
import { isTransientModelAvailabilityError } from "./retry.ts";
import type {
  LlmProvider,
  LlmProviderRegistry,
  LlmUsage,
} from "../../core/types/llm.ts";

const modelScope = Symbol("approved model call scope");
type ScopedOptions = Record<string, unknown> & {
  readonly [modelScope]?: ModelCallScope;
};

/** Bind metadata only from a trusted, already acquired execution context. */
export function bindModelCallScope(
  registry: LlmProviderRegistry,
  scope: ModelCallScope,
): LlmProviderRegistry {
  const wrap = (provider: LlmProvider | undefined) => {
    if (!provider) return;
    const stream = provider.stream;
    return {
      ...provider,
      complete(messages, tools, options) {
        return provider.complete(messages, tools, {
          ...options,
          [modelScope]: scope,
        });
      },
      ...(stream && {
        stream(messages, tools, options) {
          return stream.call(provider, messages, tools, {
            ...options,
            [modelScope]: scope,
          });
        },
      }),
    } satisfies LlmProvider;
  };
  return {
    ...registry,
    get: (name) => wrap(registry.get(name)),
    getDefault: () => wrap(registry.getDefault()),
    getForClassification: (level) => wrap(registry.getForClassification(level)),
    ...(registry.snapshotForTurn && {
      snapshotForTurn: (prior) =>
        bindModelCallScope(registry.snapshotForTurn!(prior), scope),
    }),
  };
}

export function monitorProviderRegistry(
  registry: LlmProviderRegistry,
  baseDir: string,
) {
  const monitor = modelMonitor(baseDir);
  function classification(options: Record<string, unknown>) {
    const parsed = typeof options.modelUsageClassification === "string"
      ? parseClassification(options.modelUsageClassification)
      : undefined;
    return parsed?.ok ? parsed.value : "RESTRICTED";
  }
  function wrap(provider: LlmProvider): LlmProvider {
    const model = provider.model ?? "";
    function checkCooldown(options: Record<string, unknown>) {
      (options.signal as AbortSignal | undefined)?.throwIfAborted();
      let openUntil = 0;
      try {
        openUntil = Number(
          monitor.health(classification(options), provider.name, model)
            .openUntil,
        );
      } catch {
        // The health ledger is optional for an operational provider.
      }
      if (openUntil > Date.now()) {
        throw Object.assign(new Error("The model provider is cooling down."), {
          status: 503,
        });
      }
    }
    function save(
      options: Record<string, unknown>,
      start: number,
      outcome: "success" | "failed" | "cancelled",
      usage?: LlmUsage,
      error?: unknown,
    ) {
      try {
        const status = error instanceof Error && "status" in error &&
            typeof error.status === "number"
          ? error.status
          : undefined;
        const hard = status === 401 || status === 402;
        monitor.record(
          classification(options),
          provider.name,
          model,
          outcome,
          Math.round(performance.now() - start),
          usage,
          hard
            ? "hard"
            : isTransientModelAvailabilityError(error)
            ? "transient"
            : undefined,
          status,
          (options as ScopedOptions)[modelScope],
        );
      } catch {
        // Optional measurements cannot change the result of a provider call.
      }
    }
    const stream = provider.stream;
    return {
      ...provider,
      async complete(messages, tools, options) {
        checkCooldown(options);
        const start = performance.now();
        try {
          const { [modelScope]: _scope, ...transport } =
            options as ScopedOptions;
          const result = await provider.complete(messages, tools, transport);
          save(options, start, "success", result.usage);
          return result;
        } catch (error) {
          save(
            options,
            start,
            (options.signal as AbortSignal | undefined)?.aborted
              ? "cancelled"
              : "failed",
            undefined,
            error,
          );
          throw error;
        }
      },
      ...(stream && {
        async *stream(messages, tools, options) {
          checkCooldown(options);
          const start = performance.now();
          let outcome: "success" | "failed" | "cancelled" = "cancelled";
          let usage: LlmUsage | undefined;
          let failure: unknown;
          try {
            const { [modelScope]: _scope, ...transport } =
              options as ScopedOptions;
            for await (
              const chunk of stream.call(provider, messages, tools, transport)
            ) {
              usage = chunk.usage ?? usage;
              if (chunk.done) outcome = "success";
              yield chunk;
            }
            outcome = "success";
          } catch (error) {
            failure = error;
            outcome = (options.signal as AbortSignal | undefined)?.aborted
              ? "cancelled"
              : "failed";
            throw error;
          } finally {
            save(options, start, outcome, usage, failure);
          }
        },
      }),
    };
  }

  return {
    registry: {
      ...registry,
      register(provider) {
        registry.register(wrap(provider));
      },
      registerClassificationOverride(level, provider) {
        registry.registerClassificationOverride(level, wrap(provider));
      },
    } satisfies LlmProviderRegistry,
    retryPolicy() {
      try {
        const policy = monitor.retryPolicy();
        return {
          maxRetries: Number(policy.retries),
          baseDelayMs: Number(policy.delayMs),
        };
      } catch {
        return undefined;
      }
    },
  };
}
