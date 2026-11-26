/** Identify the reviewed authenticated transport for retained inventory. */

export const retainedInventoryConnectorId = "scopesentry";

export const retainedInventoryOperations = [
  "list_assets",
  "list_projects_data",
  "list_tasks",
] as const;

export function isRetainedInventoryOperation(name: unknown): boolean {
  return retainedInventoryOperations.some((operation) => operation === name);
}

export function parseRetainedInventoryEndpoint(
  connectorId: string,
  url: unknown,
  keyReference: unknown,
  classification: unknown,
): { url: string; secretName: string } | undefined {
  if (
    connectorId !== retainedInventoryConnectorId ||
    (classification !== "INTERNAL" && classification !== "PUBLIC") ||
    typeof url !== "string" || url.length > 2048 ||
    typeof keyReference !== "string" ||
    !/^keychain:[A-Za-z0-9][A-Za-z0-9_./:-]{0,127}$/.test(keyReference)
  ) return;
  try {
    const endpoint = new URL(url);
    if (
      endpoint.protocol !== "https:" || endpoint.username ||
      endpoint.password || endpoint.search || endpoint.hash ||
      endpoint.href !== url
    ) return;
    return { url, secretName: keyReference.slice("keychain:".length) };
  } catch {
    return undefined;
  }
}
