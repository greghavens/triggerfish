/** Identify model requests that mutate the owner chat goal registration. */
export function chatGoalMutation(
  name: string,
  args: Readonly<Record<string, unknown>>,
): "register" | "revise" | undefined {
  return name === "goal_report" &&
      (args.action === "register" || args.action === "revise")
    ? args.action
    : undefined;
}
