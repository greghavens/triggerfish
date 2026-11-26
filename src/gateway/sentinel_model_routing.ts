/** Select a background assessment model using the session's fixed data classification. */
import { isDeepStrictEqual } from "node:util";
import {
  listSelectableModelProfiles,
  type ModelProfileAllowlists,
  type SelectedModelProfile,
  selectedModelProvider,
} from "../core/model_profile_selection.ts";
import type { LlmProvider, LlmProviderRegistry } from "../core/types/llm.ts";
import {
  advanceSentinelModelFallback,
  readSentinelAssessment,
} from "../sentinel/assessment_store.ts";

interface SentinelModelRun {
  readonly path: string;
  readonly runId: string;
  readonly revision: number;
  readonly alternates: readonly SelectedModelProfile[];
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
  primary: SelectedModelProfile,
  run: SentinelModelRun,
  resolve: (profile: SelectedModelProfile) => LlmProvider | undefined,
) {
  const profiles = [primary, ...run.alternates];
  const resolveIndex = (index: number) => {
    const profile = profiles[index];
    return profile && resolve(profile);
  };
  const readIndex = () => {
    const current = readSentinelAssessment(run.path);
    if (
      !current?.active || current.paused || current.revision !== run.revision ||
      current.plan.runId !== run.runId ||
      (current.plan.deadlineAt !== undefined &&
        Date.now() >= current.plan.deadlineAt) ||
      !isDeepStrictEqual(current.plan.modelProfile, primary) ||
      !isDeepStrictEqual(current.plan.modelFallbackProfiles, run.alternates)
    ) return;
    return current.plan.modelFallbackIndex ?? 0;
  };
  const initial = readIndex();
  let active = initial === undefined ? undefined : resolveIndex(initial);
  if (!active) return;
  const approvedProvider = active;
  const contextWindow = Math.min(
    ...profiles.map((profile) => resolve(profile)?.contextWindow ?? 100_000),
  );
  return {
    get name() {
      return active?.name ?? approvedProvider.name;
    },
    get model() {
      return active?.model;
    },
    supportsStreaming: false,
    contextWindow,
    async complete(messages, tools, options) {
      const signal = options.signal instanceof AbortSignal
        ? options.signal
        : undefined;
      let index = readIndex();
      while (index !== undefined) {
        signal?.throwIfAborted();
        active = resolveIndex(index);
        if (!active) break;
        try {
          return await active.complete(messages, tools, options);
        } catch (error) {
          signal?.throwIfAborted();
          if (!isAvailabilityFailure(error) || !resolveIndex(index + 1)) {
            throw error;
          }
          index = advanceSentinelModelFallback(run.path, run, index);
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
      if (profile === undefined) {
        return { providerRegistry: registry, allowModelAccess: true };
      }
      const provider = run
        ? runModelProvider(profile, run, resolve)
        : resolve(profile);
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
