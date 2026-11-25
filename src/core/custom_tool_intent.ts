/** Exact owner-approved declarative binding updates. */
export const customToolManageName = "custom_tool_manage";
export const customToolNamePattern = /^custom_[a-z][a-z0-9_]{0,47}$/;

export function isCustomToolName(name: unknown): name is string {
  return typeof name === "string" && name !== customToolManageName &&
    customToolNamePattern.test(name);
}

export function parseCustomToolApply(
  name: string,
  args: Record<string, unknown>,
) {
  if (
    name !== customToolManageName || args.action !== "apply" ||
    !isCustomToolName(args.name) ||
    typeof args.revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(args.revision) ||
    Object.keys(args).length !== 3
  ) return;
  return { name: args.name, revision: args.revision };
}
