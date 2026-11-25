/** Run a local Sentinel investigation from an imported graph snapshot. */

import { loadSentinelGraph } from "../../sentinel/graph.ts";
import { detectSentinelRegressions } from "../../sentinel/monitor.ts";

const usage = `Usage:
  triggerfish sentinel report --input=sentinel.json
  triggerfish sentinel trace --input=sentinel.json --node=ID [--depth=2]
  triggerfish sentinel compare --input=current.json --baseline=previous.json
  triggerfish sentinel watch --input=sentinel.json [--interval=5]
  triggerfish sentinel coverage --input=sentinel.json
  triggerfish sentinel impact --input=sentinel.json --node=ASSET [--depth=2]
  triggerfish sentinel path --input=sentinel.json --from=ID --to=ID [--depth=2] [--direction=both|incoming|outgoing] [--relation=TYPE] [--limit=1–10]
  triggerfish sentinel path --provenance [--case=CASE] [--revision=N] --from=ID --to=ID [--depth=2] [--direction=both|incoming|outgoing] [--relation=TYPE] [--limit=1–10]
  triggerfish sentinel detect --input=PATH|- [--format=FORMAT] [--source=ID] [--publish]
  triggerfish sentinel normalize --input=PATH|- --format=FORMAT [--source=ID]
  triggerfish sentinel publish --input=sentinel.json
  triggerfish sentinel publish-alerts --input=alerts.jsonl
  triggerfish sentinel indicators --input=PATH|- --rules=rules.json
  triggerfish sentinel export-rules --builtin --format=sigma [--source=events|alerts|upstream-alerts]
  triggerfish sentinel export-rules --rules=rules.json --format=sigma|suricata [--sid-start=9100000]
  triggerfish sentinel host-triage --asset=ID --rules=rules.json [--sqlite-snapshot=PATH] [--postgres-tables=PATH | --postgres-local-db=NAME [--postgres-socket=DIR] [--postgres-port=PORT]]
  triggerfish sentinel defense [--alerts=alerts.jsonl]
  triggerfish sentinel coverage-layer --mapping=mapping.json [--alerts=alerts.jsonl]
  triggerfish sentinel assess-start [--goal=TEXT] [--asset=ASSET] [--node=NODE] [--evidence=ID] [--depth=2]
  triggerfish sentinel assess-status [--revision=N]
  triggerfish sentinel assess-refresh | assess-history | assess-pause | assess-resume | assess-stop | assess-continue
  triggerfish sentinel assess-cases
  triggerfish sentinel assess-goal --goal=TEXT
  triggerfish sentinel assess-goal-register --criteria=JSON [--policy=operator|automatic]
  triggerfish sentinel assess-goal-state
  triggerfish sentinel assess-goal-report --scope=ID --observations=JSON
  triggerfish sentinel assess-complete --revision=N --note=TEXT [--goal=EXPECTED_TEXT] [--run-id=ID --proof-digest=SHA256]
  triggerfish sentinel assess-export [--format=markdown|csv|alerts|provenance|inventory|decisions|incidents] [--revision=N] [--language=en|es|ko|zh|ja]
  triggerfish sentinel merge --input=first.json --with=second.json
  triggerfish sentinel import-sarif --input=results.sarif --source=PROJECT
  triggerfish sentinel import-cyclonedx --input=bom.json --source=PROJECT
  triggerfish sentinel import-osv --input=scan.json --source=PROJECT
  triggerfish sentinel import-spdx --input=bom.spdx.json --source=PROJECT
  triggerfish sentinel traffic --input=PATH|- --source=PROJECT [--format=har|dns|zeek-dns|zeek-http|suricata-dns|suricata-http] [--publish] [--retain-reviewed-response] [--retain-reviewed-request] [--retain-reviewed-headers]
  triggerfish sentinel import-har --input=capture.har --source=PROJECT
  triggerfish sentinel import-misp --input=events.json --source=SOURCE
  triggerfish sentinel case --input=sentinel.json [--alerts=alerts.jsonl]
  triggerfish sentinel contain --target=HOST --reason=REASON --ttl=SECONDS
  triggerfish sentinel release --target=HOST --reason=REASON
  triggerfish sentinel decision --target=HOST
  triggerfish sentinel containments
  triggerfish sentinel audit [--limit=100]

Feed formats: jsonl, syslog, suricata, zeek, falco, wazuh, ecs, journald, winlogbeat, okta,
guardduty, scc, ocsf, entra, cef, kubernetes-audit, cloudtrail. Okta, Kubernetes audit, and CloudTrail
require --source with an inventory asset ID. CloudTrail accepts --archive=json|gzip.
Legacy syslog archives use --syslog-clock=YEAR@UTC_OFFSET. Winlogbeat accepts --privileged-groups=groups.json. CEF requires --selectors=selectors.json.`;

async function readJson(path: string): Promise<unknown> {
  const text = await Deno.readTextFile(path);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON in Sentinel input");
  }
}

async function inputStream(path: string) {
  return path === "-" ? Deno.stdin.readable : (await Deno.open(path)).readable;
}

async function readAlertsFlag(path: boolean | string | undefined) {
  if (path === undefined) return undefined;
  if (typeof path !== "string" || path === "") {
    throw new Error("Pass an alert feed with --alerts=PATH");
  }
  const { readSentinelAlerts } = await import("./sentinel_telemetry.ts");
  return await readSentinelAlerts(await inputStream(path));
}

async function readGraph(path: string) {
  return loadSentinelGraph(await readJson(path));
}

async function watchSnapshots(path: string, interval: number) {
  let baseline = (await readGraph(path)).report();
  console.error(
    JSON.stringify({ type: "watch_started", findings: baseline.length }),
  );
  let lastError: string | undefined;
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    let current;
    try {
      current = (await readGraph(path)).report();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastError) {
        console.error(JSON.stringify({ type: "snapshot_error", message }));
      }
      lastError = message;
      continue;
    }

    if (lastError !== undefined) {
      console.error(JSON.stringify({ type: "snapshot_recovered" }));
      lastError = undefined;
    }
    for (const alert of detectSentinelRegressions(baseline, current)) {
      console.log(
        JSON.stringify({ ...alert, observedAt: new Date().toISOString() }),
      );
    }
    baseline = current;
  }
}

export async function dispatchSentinelCommand(
  subcommand: string | undefined,
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  if (flags.help || subcommand === "help" || subcommand === undefined) {
    console.log(usage);
    return;
  }
  if (
    ["contain", "release", "decision", "containments", "audit"].includes(
      subcommand,
    )
  ) {
    const { dispatchContainmentCommand } = await import(
      "./sentinel_containment.ts"
    );
    await dispatchContainmentCommand(subcommand, flags);
    return;
  }
  if (
    [
      "assess-start",
      "assess-status",
      "assess-refresh",
      "assess-history",
      "assess-stop",
      "assess-complete",
      "assess-pause",
      "assess-resume",
      "assess-continue",
      "assess-goal",
      "assess-goal-register",
      "assess-goal-state",
      "assess-goal-report",
      "assess-export",
      "assess-cases",
    ].includes(subcommand)
  ) {
    const { dispatchSentinelAssessmentCommand } = await import(
      "./sentinel_assessment.ts"
    );
    dispatchSentinelAssessmentCommand(subcommand, flags);
    return;
  }
  if (subcommand === "host-triage") {
    if (typeof flags.asset !== "string" || typeof flags.rules !== "string") {
      throw new Error(
        "Pass the host ID and indicator catalog with --asset=ID --rules=PATH",
      );
    }
    const sqliteSnapshot = flags["sqlite-snapshot"];
    const postgresTables = flags["postgres-tables"];
    const postgresLocalDb = flags["postgres-local-db"];
    const postgresSocket = flags["postgres-socket"];
    const postgresPort = flags["postgres-port"];
    if (
      (sqliteSnapshot !== undefined && typeof sqliteSnapshot !== "string") ||
      (postgresTables !== undefined && typeof postgresTables !== "string") ||
      (postgresLocalDb !== undefined && typeof postgresLocalDb !== "string") ||
      (postgresSocket !== undefined && typeof postgresSocket !== "string") ||
      (postgresPort !== undefined && typeof postgresPort !== "string")
    ) {
      throw new Error(
        "Supply file paths or a local database name for optional schema evidence",
      );
    }
    const { triageLocalSentinelHost } = await import(
      "../../sentinel/host_triage.ts"
    );
    console.log(
      JSON.stringify(
        await triageLocalSentinelHost(
          await readJson(flags.rules),
          flags.asset,
          {
            sqliteSnapshot,
            postgresLocalDb,
            postgresSocket,
            postgresPort,
            postgresTables: postgresTables === undefined
              ? undefined
              : await readJson(postgresTables),
          },
        ),
        null,
        2,
      ),
    );
    return;
  }
  if (subcommand === "export-rules") {
    if (flags.builtin === true) {
      if (
        flags.format !== "sigma" || flags.rules !== undefined ||
        flags["sid-start"] !== undefined ||
        (flags.source !== undefined && flags.source !== "events" &&
          flags.source !== "alerts" && flags.source !== "upstream-alerts")
      ) {
        throw new Error(
          "Use --builtin --format=sigma with an optional --source=events|alerts|upstream-alerts",
        );
      }
      const {
        renderSentinelBuiltinSigma,
        renderSentinelAlertSigma,
        renderSentinelUpstreamAlertSigma,
      } = await import(
        "../../sentinel/builtin_rules.ts"
      );
      console.log(
        flags.source === "upstream-alerts"
          ? renderSentinelUpstreamAlertSigma()
          : flags.source === "alerts"
          ? renderSentinelAlertSigma()
          : renderSentinelBuiltinSigma(),
      );
      return;
    }
    if (
      typeof flags.rules !== "string" ||
      (flags.format !== "sigma" && flags.format !== "suricata")
    ) {
      throw new Error(
        "Pass --rules=PATH and --format=sigma or --format=suricata",
      );
    }
    const { renderSentinelSigma, renderSentinelSuricata } = await import(
      "../../sentinel/rule_export.ts"
    );
    const catalog = await readJson(flags.rules);
    if (flags.format === "sigma") {
      console.log(renderSentinelSigma(catalog));
    } else {
      const first = flags["sid-start"];
      if (
        first !== undefined &&
        (typeof first !== "string" || !/^\d+$/.test(first))
      ) throw new Error("Pass --sid-start=N");
      const { rules, skipped } = renderSentinelSuricata(
        catalog,
        first === undefined ? undefined : Number(first),
      );
      if (skipped.length) console.error(JSON.stringify({ skipped }));
      console.log(rules);
    }
    return;
  }
  if (subcommand === "coverage-layer") {
    if (typeof flags.mapping !== "string" || !flags.mapping) {
      throw new Error("Pass an ATT&CK mapping with --mapping=PATH");
    }
    const { buildSentinelNavigatorLayer } = await import(
      "../../sentinel/navigator.ts"
    );
    const layer = buildSentinelNavigatorLayer(
      await readJson(flags.mapping),
      await readAlertsFlag(flags.alerts),
    );
    console.log(JSON.stringify(layer, null, 2));
    return;
  }
  if (subcommand === "path") {
    const {
      from,
      to,
      direction = "both",
      relation,
      revision,
      provenance,
      input,
      limit,
    } = flags;
    const depth = flags.depth ?? "2";
    if (
      typeof from !== "string" || !from.trim() ||
      typeof to !== "string" || !to.trim() ||
      typeof depth !== "string" || !/^\d+$/.test(depth) || Number(depth) > 16 ||
      (direction !== "both" && direction !== "incoming" &&
        direction !== "outgoing") ||
      (limit !== undefined &&
        (typeof limit !== "string" || !/^(?:[1-9]|10)$/.test(limit))) ||
      (relation !== undefined &&
        (typeof relation !== "string" ||
          !/^[a-z_]{1,40}(?:,[a-z_]{1,40}){0,15}$/.test(relation)))
    ) {
      throw new Error(
        "Pass --from=ID and --to=ID with a valid depth, direction and relationship type.",
      );
    }

    if (provenance === true) {
      if (
        input !== undefined || (revision !== undefined &&
          (typeof revision !== "string" || !/^[1-9]\d*$/.test(revision) ||
            !Number.isSafeInteger(Number(revision))))
      ) {
        throw new Error(
          "Use --provenance with an optional --revision=N and no --input.",
        );
      }
      const { resolveSentinelCliCase } = await import(
        "./sentinel_assessment.ts"
      );
      const { readSentinelProvenance } = await import(
        "../../gateway/sentinel_adaptive_runtime.ts"
      );
      const saved = readSentinelProvenance(
        resolveSentinelCliCase(flags.case),
        revision === undefined ? undefined : Number(revision),
      );
      if (!saved) {
        throw new Error(
          "The requested Sentinel assessment revision is unavailable.",
        );
      }
      const answer = limit === undefined
        ? {
          path: saved.graph.shortestPath(
            from,
            to,
            Number(depth),
            direction,
            relation,
          ),
        }
        : saved.graph.alternatePaths(
          from,
          to,
          Number(depth),
          direction,
          relation,
          Number(limit),
        );
      console.log(
        JSON.stringify({ revision: saved.revision, ...answer }, null, 2),
      );
    } else {
      if (
        provenance !== undefined || revision !== undefined ||
        typeof input !== "string" || !input
      ) {
        throw new Error(
          "Use --input=PATH for an inventory path or --provenance for an assessment path.",
        );
      }
      const { loadSentinelGraph } = await import("../../sentinel/graph.ts");
      const graph = loadSentinelGraph(await readJson(input));
      const answer = limit === undefined
        ? {
          path: graph.shortestPath(
            from,
            to,
            Number(depth),
            direction,
            relation,
          ),
        }
        : graph.alternatePaths(
          from,
          to,
          Number(depth),
          direction,
          relation,
          Number(limit),
        );
      console.log(JSON.stringify(answer, null, 2));
    }
    return;
  }

  if (subcommand === "defense") {
    const { assessSentinelDefenseCoverage } = await import(
      "../../sentinel/defense_coverage.ts"
    );
    const { webContainmentConfigured } = await import(
      "./sentinel_assessment.ts"
    );
    const result = assessSentinelDefenseCoverage({
      alerts: await readAlertsFlag(flags.alerts),
      webContainmentConfigured: webContainmentConfigured(),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (
    ![
      "report",
      "trace",
      "compare",
      "watch",
      "coverage",
      "impact",
      "detect",
      "traffic",
      "normalize",
      "publish",
      "publish-alerts",
      "indicators",
      "merge",
      "import-sarif",
      "import-cyclonedx",
      "import-osv",
      "import-spdx",
      "import-har",
      "import-misp",
      "case",
    ].includes(subcommand)
  ) {
    throw new Error(usage);
  }
  if (typeof flags.input !== "string" || flags.input === "") {
    throw new Error("Pass an input file with --input=PATH");
  }

  if (subcommand === "traffic") {
    if (typeof flags.source !== "string" || !flags.source.trim()) {
      throw new Error("Pass a capture source with --source=PROJECT");
    }
    const { ingestSentinelTraffic } = await import("./sentinel_traffic.ts");
    const path = flags.publish === true
      ? (await import("./sentinel_assessment.ts")).resolveSentinelCliCase(
        flags.case,
      )
      : undefined;
    const format = flags.format ?? "har";
    if (
      format !== "har" && format !== "dns" && format !== "zeek-dns" &&
      format !== "zeek-http" && format !== "suricata-dns" &&
      format !== "suricata-http"
    ) {
      throw new Error(
        "Use --format=har, --format=dns, --format=zeek-dns, --format=zeek-http, --format=suricata-dns, or --format=suricata-http",
      );
    }
    await ingestSentinelTraffic(
      await inputStream(flags.input),
      flags.source,
      path,
      format,
      flags["retain-reviewed-response"] === true,
      flags["retain-reviewed-request"] === true,
      flags["retain-reviewed-headers"] === true,
    );
    return;
  }

  if (subcommand === "detect" || subcommand === "normalize") {
    const format = flags.format ?? "jsonl";
    const { isSentinelFeedFormat } = await import(
      "../../sentinel/feed_adapters.ts"
    );
    if (!isSentinelFeedFormat(format)) {
      throw new Error("Unknown Sentinel feed format");
    }
    const source = flags.source;
    if (format === "okta" && (typeof source !== "string" || !source.trim())) {
      throw new Error("Use --source=TENANT_ASSET_ID for Okta");
    }
    if (
      format === "kubernetes-audit" &&
      (typeof source !== "string" || !source.trim())
    ) {
      throw new Error("Use --source=CLUSTER_ASSET_ID for Kubernetes audit");
    }
    if (
      format === "cloudtrail" && (typeof source !== "string" || !source.trim())
    ) {
      throw new Error("Use --source=ACCOUNT_ASSET_ID for CloudTrail");
    }
    const selectorsPath = flags.selectors;
    if (
      format === "cef" && (typeof selectorsPath !== "string" || !selectorsPath)
    ) {
      throw new Error("CEF requires --selectors=selectors.json");
    }
    const selectors = format === "cef" && typeof selectorsPath === "string"
      ? (await import("../../sentinel/cef_adapter.ts"))
        .validateCefAlertSelectors(await readJson(selectorsPath))
      : undefined;
    const groupsPath = flags["privileged-groups"];
    if (
      groupsPath !== undefined &&
      (format !== "winlogbeat" || typeof groupsPath !== "string" || !groupsPath)
    ) {
      throw new Error(
        "Use --privileged-groups=groups.json with the Winlogbeat format",
      );
    }
    const privilegedGroups = typeof groupsPath === "string"
      ? (await import("../../sentinel/identity_adapters.ts"))
        .validateWinlogbeatPrivilegedGroups(await readJson(groupsPath))
      : undefined;
    const clockFlag = flags["syslog-clock"];
    if (
      clockFlag !== undefined &&
      !["syslog", "cef", "falco", "wazuh"].includes(format)
    ) {
      throw new Error("Use --syslog-clock with syslog, CEF, Falco, or Wazuh");
    }
    const syslogClock = clockFlag === undefined
      ? undefined
      : (await import("../../sentinel/feed_adapters.ts"))
        .parseSentinelSyslogClock(clockFlag);
    const feedOptions = { privilegedGroups, syslogClock };
    const { ingestSentinelTelemetry, normalizeSentinelTelemetry } =
      await import("./sentinel_telemetry.ts");
    const archive = flags.archive;
    if (
      archive !== undefined &&
      (format !== "cloudtrail" || (archive !== "json" && archive !== "gzip"))
    ) {
      throw new Error(
        "Use --archive=json or --archive=gzip with the CloudTrail format",
      );
    }
    const archiveEncoding = archive === "json" || archive === "gzip"
      ? archive
      : format === "cloudtrail" && flags.input.toLowerCase().endsWith(".gz")
      ? "gzip"
      : undefined;
    const stream = await inputStream(flags.input);
    const sourceId = typeof source === "string" ? source : undefined;
    if (subcommand === "detect") {
      const publishPath = flags.publish === true
        ? (await import("./sentinel_assessment.ts")).resolveSentinelCliCase(
          flags.case,
        )
        : undefined;
      await ingestSentinelTelemetry(
        stream,
        format,
        sourceId,
        selectors,
        publishPath,
        archiveEncoding,
        feedOptions,
      );
    } else {
      await normalizeSentinelTelemetry(
        stream,
        format,
        sourceId,
        selectors,
        archiveEncoding,
        feedOptions,
      );
    }
    return;
  }

  if (subcommand === "publish" || subcommand === "publish-alerts") {
    const { publishSentinelSnapshot, publishSentinelAlerts } = await import(
      "./sentinel_publish.ts"
    );
    const { refreshAfterPublish, resolveSentinelCliCase } = await import(
      "./sentinel_assessment.ts"
    );
    const path = resolveSentinelCliCase(flags.case);
    const result = subcommand === "publish"
      ? await publishSentinelSnapshot(flags.input, path)
      : await publishSentinelAlerts(
        await readAlertsFlag(flags.input) ?? [],
        path,
      );
    console.log(JSON.stringify({ ...result, ...refreshAfterPublish(path) }));
    return;
  }

  if (subcommand === "indicators") {
    if (typeof flags.rules !== "string" || !flags.rules) {
      throw new Error("Pass an indicator catalog with --rules=PATH");
    }
    const { ingestSentinelIndicators } = await import(
      "./sentinel_telemetry.ts"
    );
    const rules = await readJson(flags.rules);
    await ingestSentinelIndicators(await inputStream(flags.input), rules);
    return;
  }

  if (subcommand === "merge") {
    if (typeof flags.with !== "string" || !flags.with) {
      throw new Error("Pass a second snapshot with --with=PATH");
    }
    const { mergeSentinelSnapshots } = await import("../../sentinel/merge.ts");
    const snapshots = await Promise.all([
      readJson(flags.input),
      readJson(flags.with),
    ]);
    console.log(JSON.stringify(mergeSentinelSnapshots(snapshots), null, 2));
    return;
  }

  if (
    [
      "import-sarif",
      "import-cyclonedx",
      "import-osv",
      "import-spdx",
      "import-har",
      "import-misp",
    ].includes(
      subcommand,
    )
  ) {
    const source = flags.source;
    if (typeof source !== "string" || source.trim() === "") {
      throw new Error("Pass a stable source identifier with --source=ID");
    }
    const raw = await readJson(flags.input);
    let result: unknown;
    switch (subcommand) {
      case "import-sarif":
        result = await (await import("../../sentinel/sarif.ts"))
          .importSentinelSarif(raw, source);
        break;
      case "import-osv":
        result = (await import("../../sentinel/osv_scanner.ts"))
          .importSentinelOsvScanner(raw, source);
        break;
      case "import-cyclonedx":
        result = (await import("../../sentinel/cyclonedx.ts"))
          .importSentinelCycloneDx(raw, source);
        break;
      case "import-spdx":
        result = (await import("../../sentinel/spdx.ts")).importSentinelSpdx(
          raw,
          source,
        );
        break;
      case "import-har":
        result = (await import("../../sentinel/har.ts")).importSentinelHar(
          raw,
          source,
        );
        break;
      default:
        result = (await import("../../sentinel/misp_indicators.ts"))
          .importSentinelMispIndicators(raw, source);
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === "watch") {
    const interval = flags.interval ?? "5";
    if (
      typeof interval !== "string" || !/^\d+$/.test(interval) ||
      Number(interval) < 1 || Number(interval) > 3600
    ) {
      throw new Error("Pass an interval in whole seconds from 1 to 3600");
    }
    await watchSnapshots(flags.input, Number(interval));
    return;
  }

  const graph = await readGraph(flags.input);
  if (subcommand === "case") {
    const { buildSentinelCaseReport } = await import(
      "../../sentinel/case_report.ts"
    );
    const alerts = await readAlertsFlag(flags.alerts);
    console.log(
      JSON.stringify(buildSentinelCaseReport(graph, alerts), null, 2),
    );
    return;
  }
  if (subcommand === "compare") {
    if (typeof flags.baseline !== "string" || flags.baseline === "") {
      throw new Error("Pass a previous Sentinel snapshot with --baseline=PATH");
    }
    const baseline = await readGraph(flags.baseline);
    const alerts = detectSentinelRegressions(baseline.report(), graph.report());
    console.log(JSON.stringify({ alerts }, null, 2));
    return;
  }
  if (subcommand === "report") {
    console.log(JSON.stringify({ findings: graph.report() }, null, 2));
    return;
  }

  if (subcommand === "coverage") {
    console.log(
      JSON.stringify(
        graph.coverage(
          graph.snapshot().edges.some(({ relation }) => relation === "verifies")
            ? new Date().toISOString()
            : undefined,
        ),
        null,
        2,
      ),
    );
    return;
  }

  if (typeof flags.node !== "string" || flags.node === "") {
    throw new Error("Pass a Sentinel node ID with --node=ID");
  }
  const depth = flags.depth ?? "2";
  if (typeof depth !== "string" || !/^\d+$/.test(depth)) {
    throw new Error("Pass a nonnegative integer with --depth=N");
  }
  const result = subcommand === "impact"
    ? graph.impact(flags.node, Number(depth))
    : graph.trace(flags.node, Number(depth));
  console.log(JSON.stringify(result, null, 2));
}
