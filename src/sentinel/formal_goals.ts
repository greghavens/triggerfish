/** Normalize operator-approved Sentinel goals and their discrete acceptance criteria. */
import { createHash } from "node:crypto";

export interface SentinelFormalGoalCriterion {
  readonly id: string;
  readonly description: string;
  readonly source:
    | "graph_evidence"
    | "adaptive_task"
    | "finding_recheck"
    | "graph_fact";
  readonly reference: string;
}

export interface SentinelFormalGoal {
  readonly id: string;
  readonly title: string;
  readonly policy: "automatic" | "operator";
  readonly criteria: readonly SentinelFormalGoalCriterion[];
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** Parse a revision-independent target and exact task shape. */
export function parseSentinelGoalTaskReference(reference: string) {
  const match =
    /^task:(?:(trace|impact):([12])|(verify_control_coverage):pass):([^\r\n]{1,800})$/
      .exec(reference);
  if (
    !match || match[0] !== reference || match[4].includes("\x00") ||
    match[4].trim() !== match[4]
  ) {
    return undefined;
  }
  if (match[3]) {
    return { kind: "verify_control_coverage", nodeId: match[4] } as const;
  }
  const kind = match[1] === "trace" ? "trace" : "impact";
  return { kind, depth: Number(match[2]), nodeId: match[4] } as const;
}

function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid Sentinel formal goal definition");
  }
  return raw as Record<string, unknown>;
}

function exactId(id: unknown, seen: Set<string>): string {
  if (typeof id !== "string" || !identifier.test(id) || seen.has(id)) {
    throw new Error("Sentinel formal goals and criteria need unique exact IDs");
  }
  seen.add(id);
  return id;
}

function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" || !value.trim() || value.trim().length > max ||
    value.includes("\x00")
  ) throw new Error("Invalid Sentinel formal goal text");
  return value.trim();
}

function readCriteria(raw: unknown): readonly SentinelFormalGoalCriterion[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 32) {
    throw new Error(
      "Supply between one and 32 criteria for each Sentinel goal",
    );
  }
  const seen = new Set<string>();
  return raw.map((entry) => {
    const { id, description, source, reference } = record(entry);
    if (
      typeof reference !== "string" ||
      !(source === "graph_evidence" && !!reference.trim() &&
          reference.length <= 800 && !reference.includes("\x00") ||
        source === "adaptive_task" &&
          (/^adaptive:[a-f0-9]{64}$/.test(reference) ||
            parseSentinelGoalTaskReference(reference)) ||
        source === "graph_fact" &&
          /^worker-graph-fact:[a-f0-9]{64}$/.test(reference) ||
        source === "finding_recheck" &&
          /^pass:worker-finding:[a-f0-9]{64}$/.test(reference))
    ) {
      throw new Error(
        "A Sentinel goal criterion requires exact saved evidence",
      );
    }
    return {
      id: exactId(id, seen),
      description: text(description, 1000),
      source,
      reference,
    };
  });
}

export function normalizeSentinelFormalGoals(
  raw: unknown,
): readonly SentinelFormalGoal[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 32) {
    throw new Error("Supply between one and 32 Sentinel formal goals");
  }
  const seen = new Set<string>();
  const goals = raw.map((entry): SentinelFormalGoal => {
    const { id, title, policy, criteria } = record(entry);
    if (policy !== "automatic" && policy !== "operator") {
      throw new Error("Invalid Sentinel formal goal completion policy");
    }
    return {
      id: exactId(id, seen),
      title: text(title, 500),
      policy,
      criteria: readCriteria(criteria),
    };
  });
  if (new TextEncoder().encode(JSON.stringify(goals)).byteLength > 64 * 1024) {
    throw new Error("Sentinel formal goal definitions are too large");
  }
  return goals;
}

export function digestSentinelGoalProposal(goals: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizeSentinelFormalGoals(goals))).digest("hex");
}
