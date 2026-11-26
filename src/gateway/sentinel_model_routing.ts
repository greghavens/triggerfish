/** Select an assessment model using the session's fixed data classification. */
import {
  listSelectableModelProfiles,
  type ModelProfileAllowlists,
  type SelectedModelProfile,
  selectedModelProvider,
} from "../core/model_profile_selection.ts";
import type {
  SentinelModelRole,
  SentinelModelRoute,
} from "../sentinel/model_routes.ts";
import type { LlmProvider, LlmProviderRegistry } from "../core/types/llm.ts";
import {
  advanceSentinelModelFallback,
  readSentinelAssessment,
  readSentinelModelRoute,
} from "../sentinel/assessment_store.ts";

interface SentinelModelRun {
  readonly path: string;
  readonly runId: string;
  readonly revision: number;
  readonly role?: SentinelModelRole;
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
  run: SentinelModelRun | {
    readonly path: string;
    readonly interactive: true;
    readonly role: SentinelModelRole;
  },
  resolve: (profile: SelectedModelProfile) => LlmProvider | undefined,
  defaultProvider: () => LlmProvider | undefined,
) {
  const role = run.role ?? "worker";
  const resolveProvider = (
    route: SentinelModelRoute,
    index: number,
  ) => {
    const profile = route.roles?.[role] ??
      (index === 0 ? route.primary : route.alternates?.[index - 1]);
    return profile
      ? resolve(profile)
      : index === 0
      ? defaultProvider()
      : undefined;
  };
  const interactive = "interactive" in run;
  let boundRun = "runId" in run ? run.runId : undefined;
  const readRoute = () => {
    if (!interactive && "runId" in run) {
      const saved = readSentinelModelRoute(run.path, run);
      return saved && { ...saved, scope: run };
    }
    const assessment = readSentinelAssessment(run.path);
    const runId = assessment?.plan.runId;
    if (!runId || !assessment) {
      return boundRun === undefined
        ? {
          route: { activeIndex: 0 } as SentinelModelRoute,
          version: 0,
          runnable: true,
          scope: undefined,
        }
        : undefined;
    }
    boundRun ??= runId;
    if (runId !== boundRun) return;
    const scope = { runId, revision: assessment.revision, allowInactive: true };
    const saved = readSentinelModelRoute(run.path, scope);
    return saved && { ...saved, runnable: true, scope };
  };
  const initial = readRoute();
  let active = initial?.runnable
    ? resolveProvider(initial.route, initial.route.activeIndex)
    : undefined;
  // Case chat must be able to pick up a later reviewed route without using
  // the ordinary provider to answer while the current case route is revoked.
  const approvedProvider = active ??
    (interactive ? defaultProvider() : undefined);
  if (!approvedProvider) return;
  return {
    get name() {
      return active?.name ?? approvedProvider.name;
    },
    get model() {
      return active?.model;
    },
    supportsStreaming: false,
    get contextWindow() {
      const current = readRoute();
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
      const selected = readRoute();
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
            selected.route.roles?.[role] || !selected.scope ||
            !isAvailabilityFailure(error) ||
            !resolveProvider(selected.route, index + 1)
          ) throw error;
          index = advanceSentinelModelFallback(
            run.path,
            selected.scope,
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
  const defaultProvider = () =>
    registry.getForClassification("INTERNAL") ?? registry.getDefault();
  const optionsFor = (provider: LlmProvider | undefined) => ({
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
  });
  return {
    list: () => listSelectableModelProfiles(registry, "INTERNAL", allowlists),
    interactiveOptions(path: string, role: SentinelModelRole = "interactive") {
      return optionsFor(
        runModelProvider(
          { path, interactive: true, role },
          resolve,
          defaultProvider,
        ),
      );
    },
    workerOptions(profile?: SelectedModelProfile, run?: SentinelModelRun) {
      if (profile === undefined && !run) {
        return { providerRegistry: registry, allowModelAccess: true };
      }
      // Revoking or changing the active profile takes effect before the next outbound call.
      return optionsFor(
        run
          ? runModelProvider(run, resolve, defaultProvider)
          : profile && resolve(profile),
      );
    },
  };
}
