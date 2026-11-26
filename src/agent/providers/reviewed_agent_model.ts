/** Classify and pin reviewed agent model bindings without a fallback route. */
import { createHash } from "node:crypto";
import type { AgentProfileRevision } from "../../core/agent_profiles.ts";
import {
  type ModelProfileAllowlists,
  selectedModelProvider,
} from "../../core/model_profile_selection.ts";
import type { ClassificationLevel } from "../../core/types/classification.ts";
import type { LlmProviderRegistry } from "../../core/types/llm.ts";

const classifications: readonly ClassificationLevel[] = [
  "PUBLIC",
  "INTERNAL",
  "CONFIDENTIAL",
  "RESTRICTED",
];

export function withReviewedAgentModel(
  registry: LlmProviderRegistry,
  readProfile: () => AgentProfileRevision | null | undefined,
  allowlists?: ModelProfileAllowlists,
): LlmProviderRegistry {
  return {
    ...registry,
    snapshotForTurn(prior) {
      const revision = readProfile();
      if (revision === null || (revision && !revision.definition)) {
        throw new Error("The reviewed agent profile is unavailable.");
      }
      const model = revision?.definition?.modelProfile;
      if (!revision || !model) {
        if (registry.snapshotForTurn) return registry.snapshotForTurn(prior);
        if (prior !== undefined) {
          throw new Error("The original agent model profile is unavailable.");
        }
        return registry;
      }
      const resolved = new Map(classifications.map((level) => [
        level,
        selectedModelProvider(registry, model, level, allowlists),
      ]));
      if (![...resolved.values()].some(Boolean)) {
        throw new Error("The reviewed agent model is unavailable.");
      }
      const identity = classifications.map((level) =>
        createHash("sha256").update(JSON.stringify([
          "reviewed-agent-profile",
          revision.id,
          revision.version,
          model.provider,
          model.model ?? null,
          level,
          resolved.get(level) !== undefined,
        ])).digest("hex")
      ).join("");
      if (prior !== undefined && prior !== identity) {
        throw new Error("The original agent model profile is unavailable.");
      }
      return {
        ...registry,
        snapshotForTurn: undefined,
        modelRouteIdentity: identity,
        requireExactClassification: true,
        getDefault: () => undefined,
        getForClassification(level) {
          const pinned = resolved.get(level);
          const current = readProfile();
          return pinned && current?.id === revision.id &&
              current.version === revision.version &&
              selectedModelProvider(registry, model, level, allowlists) ===
                pinned
            ? pinned
            : undefined;
        },
      };
    },
  };
}
