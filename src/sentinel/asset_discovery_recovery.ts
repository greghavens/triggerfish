/** Canonical worker inputs for request-bound discovery recovery. */
import { normalizeSentinelAssetDiscoveryClaim } from "./asset_discovery_store.ts";

export const SENTINEL_ASSET_DISCOVERY_SUBMIT =
  "sentinel_submit_asset_discovery";

export function sentinelAssetDiscoveryArguments(
  value: unknown,
  assetId: string,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const { requestId, ...rest } = value as Record<string, unknown>;
  if (
    typeof requestId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestId)
  ) return;
  try {
    const { assetId: _assetId, ...claim } =
      normalizeSentinelAssetDiscoveryClaim({ ...rest, assetId });
    if (
      Object.keys(rest).length !== Object.keys(claim).length ||
      Object.keys(rest).some((key) => !Object.hasOwn(claim, key))
    ) return;
    return { ...claim, requestId: requestId.toLowerCase() };
  } catch {
    return undefined;
  }
}
