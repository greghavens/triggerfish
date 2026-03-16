/**
 * CLI handler for `triggerfish run-triggers`.
 *
 * Forces an immediate trigger run on the running gateway by sending a
 * POST request to the debug endpoint. Intended for debugging only.
 *
 * @module
 */

import { createLogger } from "../../core/logger/mod.ts";

const log = createLogger("cli.triggers");

/** Gateway port (must match server.ts default). */
const GATEWAY_PORT = 18789;

/** Send the trigger POST request to the local gateway. */
async function postTriggerRequest(): Promise<Response> {
  const url = `http://127.0.0.1:${GATEWAY_PORT}/debug/run-triggers`;
  return await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(5000),
  });
}

/** Report a non-OK gateway response and exit. */
async function reportTriggerGatewayError(response: Response): Promise<never> {
  let body = "";
  try {
    body = await response.text();
  } catch (err) {
    log.debug("Trigger response text unavailable", { operation: "invokeTriggerCycle", err });
  }
  log.error("Trigger gateway request failed", {
    operation: "runTriggers",
    status: response.status,
    body,
  });
  console.log(
    `Error: Gateway returned ${response.status}${body ? ` — ${body}` : ""}`,
  );
  Deno.exit(1);
}

/**
 * Force an immediate trigger run via the running gateway.
 *
 * Sends POST /debug/run-triggers to the local gateway. Requires the
 * gateway daemon to be running. The trigger runs asynchronously inside
 * the daemon; this command returns as soon as the gateway acknowledges
 * the request.
 */
export async function invokeTriggerCycle(): Promise<void> {
  let response: Response;
  try {
    response = await postTriggerRequest();
  } catch (err: unknown) {
    log.error("Gateway not reachable", { operation: "runTriggers", err });
    console.log("Error: Gateway is not running.");
    console.log("Start it first with: triggerfish start");
    Deno.exit(1);
  }

  if (response!.ok) {
    console.log("Trigger fired. Check daemon logs for output.");
    return;
  }
  await reportTriggerGatewayError(response!);
}

/** @deprecated Use invokeTriggerCycle instead */
export const runTriggers = invokeTriggerCycle;
