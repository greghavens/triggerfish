/** Exact owner-approved declarative binding updates. */
export const customToolManageName = "custom_tool_manage";
export const customToolNamePattern = /^custom_[a-z][a-z0-9_]{0,47}$/;

export function isCustomToolName(name: unknown): name is string {
  return typeof name === "string" && name !== customToolManageName &&
    customToolNamePattern.test(name);
}

export interface CustomToolApprovalReview {
  readonly action: "apply" | "retire" | "test";
  readonly name: string;
}

export function parseCustomToolApprovalReview(
  action: unknown,
  name: unknown,
): CustomToolApprovalReview | undefined {
  return (action === "apply" || action === "retire" || action === "test") &&
      isCustomToolName(name)
    ? { action, name }
    : undefined;
}

export function parseCustomToolMutation(
  name: string,
  args: Record<string, unknown>,
) {
  const review = parseCustomToolApprovalReview(args.action, args.name);
  if (
    name !== customToolManageName || !review ||
    typeof args.revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(args.revision) ||
    Object.keys(args).length !== 3
  ) return;
  return { ...review, revision: args.revision };
}
