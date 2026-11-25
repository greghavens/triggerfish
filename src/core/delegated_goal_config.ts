/** Operator-configured evidence bindings for delegated agent goal contracts. */
import type { GoalCompletionPolicy } from "./goal_completion.ts";

export type DelegatedAgentKind = "subagent" | "team";

export interface DelegatedGoalConfig {
  readonly scope: string;
  readonly goal: string;
  readonly policy: GoalCompletionPolicy;
  readonly criteria: readonly {
    readonly id: string;
    readonly description: string;
    readonly kind: DelegatedAgentKind;
    readonly tool: string;
    readonly result_sha256: string;
  }[];
}
