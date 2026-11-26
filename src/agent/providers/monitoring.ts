import { parseClassification } from "../../core/types/classification.ts";
import { modelMonitor } from "../../core/model_monitor.ts";
import { isTransientModelAvailabilityError } from "./retry.ts";
import type {
  LlmProvider,
  LlmProviderRegistry,
  LlmUsage,
} from "../../core/types/llm.ts";

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
        const hard = error instanceof Error && "status" in error &&
          (error.status === 401 || error.status === 402);
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
          const result = await provider.complete(messages, tools, options);
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
            for await (
              const chunk of stream.call(provider, messages, tools, options)
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
