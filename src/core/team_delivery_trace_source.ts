/** Canonical identity of a trusted team delivery trace. */
import type { SessionId } from "./types/session.ts";

const uuid = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const parentSource = new RegExp(`^${uuid}$`);
const teamSource = new RegExp(`^team-delivery:(${uuid}):(${uuid}):(${uuid})$`);

export function parseTeamDeliveryTraceSource(source: unknown) {
  const match = typeof source === "string" ? teamSource.exec(source) : null;
  if (!match) return;
  return {
    sender: match[1] as SessionId,
    teamId: match[2],
    delivery: match[3],
  };
}

export function teamDeliveryTraceSource(
  sender: SessionId,
  teamId: string,
  delivery: string,
): string {
  const source = `team-delivery:${sender}:${teamId}:${delivery}`;
  if (!parseTeamDeliveryTraceSource(source)) {
    throw new Error("Invalid team delivery trace binding");
  }
  return source;
}

/** Team deliveries and durable delegated assignments have an authenticated owner. */
export function isOwnerBoundExecutionTraceSource(
  role: unknown,
  source: unknown,
): source is string {
  return typeof source === "string" &&
    (source.startsWith("team-delivery:") ||
      (role === "delegated" && parentSource.test(source)));
}

/** Leave legacy exploration and configured scheduler sources visible. */
export function executionTraceSourceVisible(
  role: unknown,
  source: unknown,
  owner: unknown,
): boolean {
  if (!isOwnerBoundExecutionTraceSource(role, source)) return true;
  if (!source.startsWith("team-delivery:")) return source === owner;
  const parsed = parseTeamDeliveryTraceSource(source);
  return parsed !== undefined && parsed.sender === owner;
}
