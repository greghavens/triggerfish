/** Exact model routing for runs with an approved provider binding. */
import type { ClassificationLevel } from "./types/classification.ts";
import type { LlmProviderRegistry } from "./types/llm.ts";

export interface SelectedModelProfile {
  readonly provider: string;
  readonly model?: string;
}

export type ModelProfileAllowlists = Readonly<
  Partial<Record<ClassificationLevel, readonly string[]>>
>;

export function isModelProfileName(value: unknown): value is string {
  return typeof value === "string" &&
    /^[a-zA-Z\d][a-zA-Z\d._-]{0,63}$/.test(value);
}

export function isSelectedModelProfile(
  value: unknown,
): value is SelectedModelProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record).every((key) =>
    key === "provider" || key === "model"
  ) &&
    isModelProfileName(record.provider) &&
    (record.model === undefined ||
      (typeof record.model === "string" && record.model.length > 0 &&
        record.model.length <= 256 && !/[\x00-\x1f\x7f]/.test(record.model)));
}

export function listSelectableModelProfiles(
  registry: LlmProviderRegistry,
  classification: ClassificationLevel,
  allowlists?: ModelProfileAllowlists,
): readonly SelectedModelProfile[] {
  return (allowlists?.[classification] ?? []).flatMap((name) => {
    const provider = registry.get(name);
    if (!provider || provider.name !== name) return [];
    const profile = {
      provider: provider.name,
      ...(provider.model !== undefined && { model: provider.model }),
    };
    return isSelectedModelProfile(profile) ? [profile] : [];
  });
}

export function selectedModelProvider(
  registry: LlmProviderRegistry,
  profile: SelectedModelProfile,
  classification: ClassificationLevel,
  allowlists?: ModelProfileAllowlists,
) {
  if (
    !isSelectedModelProfile(profile) ||
    !allowlists?.[classification]?.includes(profile.provider)
  ) return undefined;
  const provider = registry.get(profile.provider);
  return provider?.name === profile.provider && provider.model === profile.model
    ? provider
    : undefined;
}
