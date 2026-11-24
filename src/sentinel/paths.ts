import { dirname, join } from "@std/path";

/** Shared location for the CLI and gateway containment policy. */
export function sentinelContainmentPath(baseDir: string): string {
  return join(baseDir, "data", "sentinel-containment.db");
}

/** Operator-managed snapshot exposed to authenticated Sentinel chat. */
export function sentinelSnapshotPath(baseDir: string): string {
  return join(baseDir, "data", "sentinel.json");
}

/** Operator-published telemetry evidence adjacent to the graph. */
export function sentinelAlertsPath(snapshotPath: string): string {
  return join(dirname(snapshotPath), "sentinel-alerts.json");
}

/** Rolling capture metadata published independently of the operator inventory. */
export function sentinelTrafficPath(snapshotPath: string): string {
  return join(dirname(snapshotPath), "sentinel-traffic.json");
}

/** Rolling DNS observations from a trusted external collector. */
export function sentinelDnsPath(snapshotPath: string): string {
  return join(dirname(snapshotPath), "sentinel-dns.json");
}

/** Native Triggerfish fetch metadata, stored separately from external collectors. */
export function sentinelNativeCapturePath(snapshotPath: string): string {
  return join(dirname(snapshotPath), "sentinel-native-http.json");
}

/** Cross-case asset links explicitly brought into a case's assessment. */
export function sentinelSharedTopologyPath(snapshotPath: string): string {
  return join(dirname(snapshotPath), "sentinel-shared-topology.json");
}
