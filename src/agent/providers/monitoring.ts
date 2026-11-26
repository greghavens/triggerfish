import { parseClassification } from "../../core/types/classification.ts";
import { modelMonitor } from "../../core/model_monitor.ts";
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
  function wrap(provider: LlmProvider): LlmProvider {
    const model = provider.model ?? "";
    function save(
      options: Record<string, unknown>,
      start: number,
      outcome: "success" | "failed" | "cancelled",
      usage?: LlmUsage,
    ) {
      try {
        const classification =
          typeof options.modelUsageClassification === "string"
            ? parseClassification(options.modelUsageClassification)
            : undefined;
        monitor.record(
          classification?.ok ? classification.value : "RESTRICTED",
          provider.name,
          model,
          outcome,
          Math.round(performance.now() - start),
          usage,
        );
      } catch {
        // Optional measurements cannot change the result of a provider call.
      }
    }
    const stream = provider.stream;
    return {
      ...provider,
      async complete(messages, tools, options) {
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
          );
          throw error;
        }
      },
      ...(stream && {
        async *stream(messages, tools, options) {
          const start = performance.now();
          let outcome: "success" | "failed" | "cancelled" = "cancelled";
          let usage: LlmUsage | undefined;
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
            outcome = (options.signal as AbortSignal | undefined)?.aborted
              ? "cancelled"
              : "failed";
            throw error;
          } finally {
            save(options, start, outcome, usage);
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
