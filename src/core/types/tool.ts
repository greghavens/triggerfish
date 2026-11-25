/**
 * Tool definition types for prompt-based tool calling.
 *
 * Extracted into core so that tool modules, integrations, and the agent
 * orchestrator can all depend on these types without circular imports.
 *
 * @module
 */

/** A tool definition for prompt-based tool calling. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<
    Record<string, {
      readonly type: string;
      readonly description: string;
      readonly required?: boolean;
      readonly items?: Readonly<Record<string, unknown>>;
      readonly enum?: readonly string[];
    }>
  >;
}

export interface ToolExecutionContext {
  readonly allowSentinelCapture?: boolean;
  readonly isCurrentInteractiveOwner?: () => boolean;
  readonly ownerSessionId?: string;
  readonly reauthorizeOwnerApproval?: () => Promise<boolean>;
}

/** Handler that executes a tool call and returns the result text. */
export type ToolExecutor = (
  name: string,
  input: Record<string, unknown>,
  context?: ToolExecutionContext,
) => Promise<string>;
