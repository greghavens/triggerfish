/** Select a background assessment model using the session's fixed data classification. */
import {
  listSelectableModelProfiles,
  type ModelProfileAllowlists,
  type SelectedModelProfile,
  selectedModelProvider,
} from "../core/model_profile_selection.ts";
import type { LlmProvider, LlmProviderRegistry } from "../core/types/llm.ts";
import {
  advanceSentinelModelFallback,
  readSentinelModelRoute,
} from "../sentinel/assessment_store.ts";

interface SentinelModelRun {
  readonly path: string;
  readonly runId: string;
  readonly revision: number;
  readonly alternates?: readonly SelectedModelProfile[];
}

/** Use typed SDK statuses or the provider's status prefix. */
function isAvailabilityFailure(error: unknown) {
  if (!(error instanceof Error)) return false;
  if ("status" in error && typeof error.status === "number") {
    return error.status === 429 || error.status === 502 || error.status === 503;
  }
  return /^[A-Za-z\d ./_-]{1,96}\((?:429|502|503)\)(?::|$)/.test(
    error.message,
  ) ||
    /^OpenRouter request failed after \d+ retries: (?:HTTP|API) (?:429|502|503):/
      .test(error.message);
}

function runModelProvider(
  run: SentinelModelRun,
  resolve: (profile: SelectedModelProfile) => LlmProvider | undefined,
  defaultProvider: () => LlmProvider | undefined,
) {
  const resolveProvider = (
    route: NonNullable<ReturnType<typeof readSentinelModelRoute>>["route"],
    index: number,
  ) => {
    const profile = index === 0 ? route.primary : route.alternates?.[index - 1];
    return profile
      ? resolve(profile)
      : index === 0
      ? defaultProvider()
      : undefined;
  };
  const initial = readSentinelModelRoute(run.path, run);
  let active = initial?.runnable
    ? resolveProvider(initial.route, initial.route.activeIndex)
    : undefined;
  if (!active) return;
  const approvedProvider = active;
  return {
    get name() {
      return active?.name ?? approvedProvider.name;
    },
    get model() {
      return active?.model;
    },
    supportsStreaming: false,
    get contextWindow() {
      const current = readSentinelModelRoute(run.path, run);
      if (!current) return approvedProvider.contextWindow;
      return Math.min(...Array.from(
        { length: (current.route.alternates?.length ?? 0) + 1 },
        (_, index) =>
          resolveProvider(current.route, index)?.contextWindow ?? 100_000,
      ));
    },
    async complete(messages, tools, options) {
      const signal = options.signal instanceof AbortSignal
        ? options.signal
        : undefined;
      const selected = readSentinelModelRoute(run.path, run);
      let index = selected?.runnable ? selected.route.activeIndex : undefined;
      while (selected && index !== undefined) {
        signal?.throwIfAborted();
        active = resolveProvider(selected.route, index);
        if (!active) break;
        try {
          return await active.complete(messages, tools, options);
        } catch (error) {
          signal?.throwIfAborted();
          if (
            !isAvailabilityFailure(error) ||
            !resolveProvider(selected.route, index + 1)
          ) throw error;
          index = advanceSentinelModelFallback(
            run.path,
            run,
            index,
            selected.version,
          );
          if (index === undefined) throw error;
        }
      }
      throw new Error("The approved Sentinel model route is unavailable.");
    },
  } satisfies LlmProvider;
}

export function sentinelAssessmentModelRouting(
  registry: LlmProviderRegistry,
  allowlists?: ModelProfileAllowlists,
) {
  const resolve = (profile: SelectedModelProfile) =>
    selectedModelProvider(registry, profile, "INTERNAL", allowlists);
  return {
    list: () => listSelectableModelProfiles(registry, "INTERNAL", allowlists),
    workerOptions(profile?: SelectedModelProfile, run?: SentinelModelRun) {
      if (profile === undefined && !run) {
        return { providerRegistry: registry, allowModelAccess: true };
      }
      const provider = run
        ? runModelProvider(
          run,
          resolve,
          () =>
            registry.getForClassification("INTERNAL") ?? registry.getDefault(),
        )
        : profile && resolve(profile);
      // Revoking or changing the active profile takes effect before the next outbound call.
      return {
        providerRegistry: provider
          ? {
            ...registry,
            getForClassification: (classification) =>
              classification === "INTERNAL"
                ? provider
                : registry.getForClassification(classification),
          } satisfies LlmProviderRegistry
          : registry,
        allowModelAccess: provider !== undefined,
      };
    },
  };
}
