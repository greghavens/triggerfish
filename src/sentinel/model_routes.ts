/** Durable classified model selection and reviewed route edits for an assessment. */
import { isDeepStrictEqual } from "node:util";
import {
  isSelectedModelProfile,
  parseModelFallbackProfiles,
  type SelectedModelProfile,
} from "../core/model_profile_selection.ts";

export const sentinelModelRoles = [
  "interactive",
  "planner",
  "worker",
  "goals",
  "reporter",
  "recheck",
] as const;
export type SentinelModelRole = typeof sentinelModelRoles[number];
export type SentinelRoleModels = Readonly<
  Partial<Record<SentinelModelRole, SelectedModelProfile>>
>;

export function isSentinelModelRole(
  value: unknown,
): value is SentinelModelRole {
  return sentinelModelRoles.some((role) => role === value);
}

export interface SentinelModelRoute {
  readonly primary?: SelectedModelProfile;
  readonly alternates?: readonly SelectedModelProfile[];
  readonly activeIndex: number;
  readonly roles?: SentinelRoleModels;
}

/** Specialized routes inherit the existing role defaults until explicitly reviewed. */
export function sentinelModelRoleProfile(
  route: SentinelModelRoute,
  role: SentinelModelRole,
): SelectedModelProfile | undefined {
  const inheritedRole = role === "goals"
    ? "interactive"
    : role === "reporter" || role === "recheck"
    ? "worker"
    : role;
  return route.roles?.[role] ?? route.roles?.[inheritedRole];
}

export interface SentinelModelRouteEdit {
  readonly requestId: string;
  readonly runId: string;
  readonly revision: number;
  readonly version: number;
  readonly operator: "owner";
  readonly approvedAt: string;
  readonly before: SentinelModelRoute;
  readonly after: SentinelModelRoute;
}

export const sentinelModelRouteEditLimit = 16;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function parseSentinelModelRoute(
  value: unknown,
): SentinelModelRoute | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const { primary, alternates, activeIndex, roles, ...extra } = value as Record<
    string,
    unknown
  >;
  if (
    Object.keys(extra).length ||
    (primary !== undefined && !isSelectedModelProfile(primary)) ||
    typeof activeIndex !== "number" || !Number.isSafeInteger(activeIndex) ||
    activeIndex < 0
  ) return;
  const exact = parseModelFallbackProfiles(
    alternates,
    primary as SelectedModelProfile | undefined,
  );
  if (
    (alternates !== undefined && !exact) || activeIndex > (exact?.length ?? 0)
  ) return;
  if (
    roles !== undefined && (!roles || typeof roles !== "object" ||
      Array.isArray(roles) || !Object.keys(roles).length ||
      Object.entries(roles).some(([role, profile]) =>
        !isSentinelModelRole(role) || !isSelectedModelProfile(profile)
      ))
  ) return;
  return {
    ...(primary !== undefined && { primary }),
    ...(roles !== undefined && { roles }),
    ...(exact && { alternates: exact }),
    activeIndex,
  } as SentinelModelRoute;
}

/** Preserve the difference between a reviewed route edit and a provider failover. */
export function validSentinelModelRouteHistory(
  value: unknown,
  runId: string,
  revision: number,
  current: SentinelModelRoute,
): value is readonly SentinelModelRouteEdit[] {
  if (
    !Array.isArray(value) || !value.length ||
    value.length > sentinelModelRouteEditLimit
  ) return false;
  const requests = new Set<string>();
  let previous: SentinelModelRoute | undefined;
  let previousRevision = 0;
  for (const [offset, entry] of value.entries()) {
    if (
      !entry || typeof entry !== "object" || Object.keys(entry).length !== 8 ||
      typeof entry.requestId !== "string" || !uuid.test(entry.requestId) ||
      requests.has(entry.requestId) || entry.runId !== runId ||
      typeof entry.revision !== "number" ||
      !Number.isSafeInteger(entry.revision) ||
      entry.revision < 1 || entry.revision < previousRevision ||
      entry.revision > revision || entry.version !== offset + 1 ||
      entry.operator !== "owner" || typeof entry.approvedAt !== "string" ||
      !Number.isFinite(Date.parse(entry.approvedAt)) ||
      new Date(entry.approvedAt).toISOString() !== entry.approvedAt
    ) return false;
    const before = parseSentinelModelRoute(entry.before);
    const after = parseSentinelModelRoute(entry.after);
    if (
      !before || !after || !continuesModelRoute(previous, before) ||
      isDeepStrictEqual(before, after)
    ) return false;
    previous = after;
    previousRevision = entry.revision;
    requests.add(entry.requestId);
  }
  return continuesModelRoute(previous, current);
}

function continuesModelRoute(
  previous: SentinelModelRoute | undefined,
  current: SentinelModelRoute,
) {
  return !previous || (isDeepStrictEqual(previous.primary, current.primary) &&
    isDeepStrictEqual(previous.alternates, current.alternates) &&
    isDeepStrictEqual(previous.roles, current.roles) &&
    previous.activeIndex <= current.activeIndex);
}
