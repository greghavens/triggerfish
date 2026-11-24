import { dirname } from "@std/path";
import { openSentinelContainment } from "../../sentinel/containment.ts";
import { sentinelContainmentPath } from "../../sentinel/paths.ts";
import { resolveBaseDir } from "../config/paths.ts";

export async function dispatchContainmentCommand(
  subcommand: string,
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  const path = sentinelContainmentPath(resolveBaseDir());
  await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const policy = openSentinelContainment(path);
  try {
    switch (subcommand) {
      case "containments":
        console.log(JSON.stringify(policy.list(), null, 2));
        return;
      case "audit": {
        const limit = flags.limit ?? "100";
        if (typeof limit !== "string" || !/^\d+$/.test(limit)) {
          throw new Error("Pass an audit entry count with --limit=N");
        }
        console.log(JSON.stringify(policy.audit(Number(limit)), null, 2));
        return;
      }
    }

    const target = flags.target;
    if (typeof target !== "string" || target === "") {
      throw new Error("Pass a hostname or IP address with --target=HOST");
    }
    if (subcommand === "decision") {
      console.log(JSON.stringify(policy.check(target), null, 2));
      return;
    }

    const reason = flags.reason;
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new Error("Pass an operator reason with --reason=REASON");
    }
    if (subcommand === "release") {
      console.log(JSON.stringify(policy.release({ target, reason }), null, 2));
      return;
    }

    const ttl = flags.ttl;
    if (typeof ttl !== "string" || !/^\d+$/.test(ttl)) {
      throw new Error("Pass an expiration in whole seconds with --ttl=SECONDS");
    }
    console.log(JSON.stringify(
      policy.block({
        target,
        reason,
        ttlSeconds: Number(ttl),
      }),
      null,
      2,
    ));
  } finally {
    policy.close();
  }
}
