/** Select a background assessment model using the session's fixed data classification. */
import {
  listSelectableModelProfiles,
  type ModelProfileAllowlists,
  type SelectedModelProfile,
  selectedModelProvider,
} from "../core/model_profile_selection.ts";
import type { LlmProviderRegistry } from "../core/types/llm.ts";

export function sentinelAssessmentModelRouting(
  registry: LlmProviderRegistry,
  allowlists?: ModelProfileAllowlists,
) {
  return {
    list: () => listSelectableModelProfiles(registry, "INTERNAL", allowlists),
    workerOptions(profile?: SelectedModelProfile) {
      if (profile === undefined) {
        return { providerRegistry: registry, allowModelAccess: true };
      }
      const provider = selectedModelProvider(
        registry,
        profile,
        "INTERNAL",
        allowlists,
      );
      // Fail closed if a saved profile is revoked or its configured model changes.
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
