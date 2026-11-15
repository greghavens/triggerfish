/**
 * Fail-closed owner determination shared by all channel adapters.
 *
 * Channel adapters must never decide that a sender is the owner unless an
 * owner identifier is explicitly configured AND matches the sender. This
 * helper is the single place that comparison exists (CHANNELS-1).
 *
 * @module
 */

/**
 * Determine whether a message sender is the configured channel owner.
 *
 * Fail closed: when the owner identifier is not configured (or empty, or the
 * sender is unknown), NO sender is the owner. A channel without an owner
 * identifier answers everyone as a non-owner instead of granting owner
 * privileges to strangers — matching the WhatsApp/Signal adapters.
 *
 * Identifiers are compared as strings so numeric IDs (Telegram) match their
 * YAML string form.
 */
export function resolveOwnerStatus(
  senderId: string | number | undefined,
  ownerId: string | number | undefined,
): boolean {
  if (ownerId === undefined || senderId === undefined) return false;
  const owner = String(ownerId);
  const sender = String(senderId);
  if (owner.length === 0 || sender.length === 0) return false;
  return sender === owner;
}
