/** Serialized identity of the provider route at every supported classification. */
export function isModelRouteIdentity(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{256}$/.test(value);
}
