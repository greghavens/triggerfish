/** Canonical identity of a trusted team delivery trace. */
import type { SessionId } from "./types/session.ts";

const uuid = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
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

/** Unscoped legacy sources are visible; team sources require their exact sender. */
export function teamDeliveryTraceVisible(
  source: unknown,
  owner: unknown,
): boolean {
  if (typeof source !== "string" || !source.startsWith("team-delivery:")) {
    return true;
  }
  const parsed = parseTeamDeliveryTraceSource(source);
  return parsed !== undefined && parsed.sender === owner;
}
