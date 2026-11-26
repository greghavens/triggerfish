import { liveProviderRouteSettings } from "../../agent/providers/live_routes.ts";
import type { ModelsConfig } from "../../agent/providers/config.ts";
import { readSentinelAdmissionSettings } from "../sentinel_admission_settings.ts";
import { createWorkflowObservationVerifier } from "../scheduled_observation_tool.ts";
import { listEffectiveModelProfiles } from "../../agent/llm.ts";
/**
 * Service startup phase — builds chat session and launches network services.
 *
 * Creates the main chat session, starts Tidepool and Gateway servers,
 * wires messaging channels, starts the scheduler, and assembles
 * shutdown dependencies.
 *
 * @module
 */

import type { SentinelCoordinatorLookup } from "../sentinel_case_manager.ts";
import { dirname, join } from "@std/path";
import { openSentinelAdaptiveStore } from "../../sentinel/adaptive_store.ts";
import {
  needsSentinelAssessmentCoordinator,
  type readSentinelAssessment,
} from "../../sentinel/assessment_store.ts";
import {
  listSentinelCaseIds,
  locateSentinelCase,
  resolveSentinelCasePath,
} from "../../sentinel/cases.ts";
import { sentinelSnapshotPath } from "../../sentinel/paths.ts";
import { createKeychain } from "../../core/secrets/keychain/keychain.ts";
import { configuredSentinelWorkflowReader } from "./factory/sentinel_workflow_source.ts";
import { configuredSentinelRepositoryVisibilityReader } from "./factory/sentinel_repository_visibility_source.ts";
import { createOperatorRunToolExecutor } from "../operator_run_tool.ts";
import { createOperatorWorkflowRuns } from "../operator_workflow_runs.ts";
import {
  buildExecutionTracePayloadAuthorizer,
  buildWorkflowRecoveryExecutor,
} from "./factory/agent_recovery.ts";
import { buildOwnerSubagentRecoveryCommand } from "./factory/owner_subagent_recovery.ts";
import { buildSubagentFactory } from "./factory/subagent.ts";
import type { createLogger } from "../../core/logger/mod.ts";
import type { createSchedulerService } from "../../scheduler/service.ts";
import type { buildSchedulerConfig } from "./factory/scheduler_config.ts";
import { createTidePoolTools } from "../../tools/tidepool/mod.ts";
import { createChatSession } from "../chat.ts";
import { createSentinelSubagent } from "../sentinel_agent.ts";
import { sentinelAssessmentModelRouting } from "../sentinel_model_routing.ts";
import {
  readSentinelSharedAssetDiscoveries,
  submitSentinelAssetDiscovery,
} from "../sentinel_asset_discoveries.ts";
import {
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
  createSentinelWorkerPool,
  readAssignedSentinelModelReview,
  readSentinelModelSettings,
  recordSentinelModelUsage,
} from "../sentinel_adaptive_runtime.ts";
import { bindSentinelCaseAdmission } from "../sentinel_case_admission.ts";
import { startSentinelCaseManager } from "../sentinel_case_manager.ts";
import { startSentinelTopologySync } from "../sentinel_topology_sync.ts";
import { startSentinelAssessmentCoordinator } from "../sentinel_assessment_service.ts";
import type { BootstrapResult } from "./bootstrap.ts";
import type { CoreInfraResult } from "./infra/core_infra.ts";
import type { ToolInfraResult } from "./tools/tool_infra.ts";
import { resolveWorkspacePathForTaint } from "./tools/tool_executor.ts";
import {
  OWNER_MEMORY_AGENT_ID,
  type SessionId,
  type UserId,
} from "../../core/types/session.ts";
import type { ShutdownDeps } from "./shutdown.ts";
import {
  assembleChatSession,
  startGatewayServer,
  startTidepoolHost,
  wireMessageChannels,
  wrapChatSessionForGateway,
  wrapChatSessionForTidepool,
} from "./services/chat_session.ts";
import { registerTidepoolTopicHandlers } from "./services/tidepool_topics.ts";

/** Create the main chat session from assembled infrastructure. */
export function buildMainChatSession(
  bootstrap: BootstrapResult,
  coreInfra: CoreInfraResult,
  toolInfra: ToolInfraResult,
  isTidepoolCallRef: { value: boolean },
  isOwnerTurnRef: { value: boolean },
  onSentinelAdmissionChanged?: () => void,
  goalWorkflowMonitor?: { stop?: () => void },
) {
  const liveRouteAllowlist =
    (bootstrap.config.models as ModelsConfig).live_route_allowlists;
  const modelsConfig = bootstrap.config.models as
    | Record<string, unknown>
    | undefined;
  const authorizeExecutionEvidence = buildExecutionTracePayloadAuthorizer(
    bootstrap.config,
    toolInfra.mainKeychain,
  );
  const readLiveWorkflow = configuredSentinelWorkflowReader(
    bootstrap.config,
    bootstrap.baseDir,
    createKeychain,
  );
  const workflows = createOperatorWorkflowRuns(
    toolInfra.workflowRunRegistry,
    bootstrap.config.operator_workflows ?? [],
    join(bootstrap.baseDir, "operator-workflow-runs.db"),
    createWorkflowObservationVerifier(
      bootstrap.baseDir,
      authorizeExecutionEvidence,
      Date.now,
      readLiveWorkflow,
    ),
  );
  workflows.recoverWaiting();
  if (goalWorkflowMonitor) {
    goalWorkflowMonitor.stop = workflows.startGoalEnrollmentMonitor().stop;
  }
  return assembleChatSession({
    customToolsBaseDir: bootstrap.baseDir,
    enableOwnerContextCompaction:
      bootstrap.config.owner_context_compaction === true,
    sideQuestionTracePath: join(bootstrap.baseDir, "execution-traces.db"),
    ownerRecoveryTracePath: join(bootstrap.baseDir, "execution-traces.db"),
    resolveSideQuestionSession: (id) =>
      coreInfra.enhancedSessionManager.get(id as SessionId),
    operatorRunExecutor: createOperatorRunToolExecutor({
      baseDir: bootstrap.baseDir,
      resumeScheduledExecution: coreInfra.schedulerService
        ?.resumeScheduledExecution,
      readLiveWorkflow,
      readRepositoryVisibility: configuredSentinelRepositoryVisibilityReader(
        bootstrap.config,
        bootstrap.baseDir,
        createKeychain,
      ),
      sentinelModelAccess:
        bootstrap.config.sentinel?.allow_model_access === true,
      sentinelGatewayWorkerLimit:
        bootstrap.config.sentinel?.model_worker_limit ?? 2,
      sentinelAdmission:
        bootstrap.config.sentinel?.assessment_concurrency !== undefined
          ? {
            configuredLimit: bootstrap.config.sentinel.assessment_concurrency,
            onChanged: onSentinelAdmissionChanged,
          }
          : undefined,
      authorizeExecutionTracePayload: authorizeExecutionEvidence,
      workflows,
      confirm: (request) => toolInfra.state.activeConfirmPrompt(request),
      webContainmentConfigured:
        bootstrap.config.web?.domains?.sentinel_containment === true,
      liveModelRoutes: liveRouteAllowlist
        ? liveProviderRouteSettings(
          toolInfra.registry,
          bootstrap.baseDir,
          liveRouteAllowlist,
        )
        : undefined,
      profiles: (ceiling) =>
        listEffectiveModelProfiles(toolInfra.registry, ceiling),
      sentinelProfiles: bootstrap.config.sentinel?.allow_model_access === true
        ? sentinelAssessmentModelRouting(
          toolInfra.registry,
          bootstrap.config.sentinel.model_profile_allowlists,
        ).list
        : undefined,
    }),
    runTeamRecoveryCommand: toolInfra.runTeamRecoveryCommand,
    runSubagentRecoveryCommand: buildOwnerSubagentRecoveryCommand(
      buildSubagentFactory(coreInfra.factory, {
        executionTracePath: join(bootstrap.baseDir, "execution-traces.db"),
      }),
      buildWorkflowRecoveryExecutor(
        bootstrap.config,
        bootstrap.baseDir,
        toolInfra.mainKeychain,
        undefined,
        undefined,
        false,
        { checklistRole: "delegated" },
      ),
      (source) =>
        buildWorkflowRecoveryExecutor(
          bootstrap.config,
          bootstrap.baseDir,
          toolInfra.mainKeychain,
          undefined,
          source,
          false,
          { checklistRole: "delegated" },
        ),
    ),
    recoverAgentTurn: buildWorkflowRecoveryExecutor(
      bootstrap.config,
      bootstrap.baseDir,
      toolInfra.mainKeychain,
      () => toolInfra.state.session.taint,
      undefined,
      true,
      {
        readLiveWorkflow: configuredSentinelWorkflowReader(
          bootstrap.config,
          bootstrap.baseDir,
          createKeychain,
        ),
        authorizeExecutionTracePayload: authorizeExecutionEvidence,
      },
    ),
    goalCompletionPath: join(bootstrap.baseDir, "goal-completion.db"),
    async runManagedGoalCommand(command, ceiling, traceAccess) {
      if (
        command === "/goal scheduler" || command.startsWith("/goal scheduler ")
      ) {
        return await coreInfra.schedulerGoalCommand?.(
          command,
          ceiling,
          traceAccess,
        ) ??
          "No scheduled goal completion is configured.";
      }
      return await coreInfra.factory.runDelegatedGoalCommand?.(
        command,
        ceiling,
        traceAccess,
      );
    },
    sentinelSnapshotPath: sentinelSnapshotPath(bootstrap.baseDir),
    sentinelSharedInventoryBaseDir: bootstrap.baseDir,
    resolveSentinelChatCase(caseId) {
      if (!listSentinelCaseIds(bootstrap.baseDir).includes(caseId)) {
        return undefined;
      }
      return resolveSentinelCasePath(bootstrap.baseDir, caseId);
    },
    hookRunner: toolInfra.hookRunner,
    registry: toolInfra.registry,
    spinePath: toolInfra.spinePath,
    mcpWiring: toolInfra.mcpWiring,
    isTidepoolCallRef,
    tidepoolToolsRef: toolInfra.tidepoolToolsRef,
    toolExecutor: toolInfra.toolExecutor,
    skillsPrompt: toolInfra.skillsPrompt,
    triggersPrompt: toolInfra.triggersPrompt,
    mainKeychain: toolInfra.mainKeychain,
    state: toolInfra.state,
    streamingPref: modelsConfig?.streaming,
    config: bootstrap.config,
    visionProvider: toolInfra.visionProvider,
    toolClassifications: toolInfra.toolClassifications,
    integrationClassifications: toolInfra.integrationClassifications,
    classifyGitHubRepo: toolInfra.classifyGitHubRepo,
    browserHandle: toolInfra.browserHandle,
    log: bootstrap.log,
    pairingService: coreInfra.pairingService,
    pathClassifier: toolInfra.pathClassifier,
    domainClassifier: toolInfra.domainClassifier,
    toolFloorRegistry: toolInfra.toolFloorRegistry,
    getActiveSkillContext: toolInfra.skillContextTracker
      ? () => toolInfra.skillContextTracker!.getActive()
      : undefined,
    triggerStore: coreInfra.triggerStore,
    broadcastChatEvent: (event) => {
      coreInfra.gatewayServerRef.value?.broadcastChatEvent(event);
      coreInfra.tidepoolHostRef.value?.broadcastChatEvent(event);
    },
    workspacePaths: {
      publicPath: toolInfra.mainWorkspace.publicPath,
      internalPath: toolInfra.mainWorkspace.internalPath,
      confidentialPath: toolInfra.mainWorkspace.confidentialPath,
      restrictedPath: toolInfra.mainWorkspace.restrictedPath,
    },
    getWorkspacePath: () =>
      resolveWorkspacePathForTaint(
        toolInfra.state.session.taint,
        {
          publicPath: toolInfra.mainWorkspace.publicPath,
          internalPath: toolInfra.mainWorkspace.internalPath,
          confidentialPath: toolInfra.mainWorkspace.confidentialPath,
          restrictedPath: toolInfra.mainWorkspace.restrictedPath,
        },
      ),
    serviceAvailability: toolInfra.serviceAvailability,
    personaOptions: {
      memoryStore: toolInfra.memoryStore,
      agentId: OWNER_MEMORY_AGENT_ID,
      getSessionTaint: () => toolInfra.state.session.taint,
      isOwnerSession: () => isOwnerTurnRef.value,
    },
    isOwnerTurnRef,
    messageStore: coreInfra.messageStore,
    lineageStore: coreInfra.lineageStore,
    storage: coreInfra.storage,
    ownerId: "owner",
  });
}

/** Start the Tidepool host and wire tool references + topic handlers. */
export async function launchTidepoolService(
  toolInfra: ToolInfraResult,
  chatSession: ReturnType<typeof createChatSession>,
  isTidepoolCallRef: { value: boolean },
  notificationService: CoreInfraResult["notificationService"],
  bootstrap: BootstrapResult,
  coreInfra: CoreInfraResult,
  coordinatorState?: SentinelCoordinatorLookup,
) {
  const tidepoolChatSession = wrapChatSessionForTidepool(
    chatSession,
    isTidepoolCallRef,
    toolInfra.state,
    toolInfra.cliSecretPrompt,
    toolInfra.cliCredentialPrompt,
    toolInfra.cliConfirmPrompt,
  );
  const tidepoolHost = await startTidepoolHost(
    tidepoolChatSession,
    notificationService,
    bootstrap.log,
  );
  toolInfra.tidepoolToolsRef.value = createTidePoolTools(tidepoolHost);
  toolInfra.mcpBroadcastRefs.tidepoolHost = tidepoolHost;

  registerTidepoolTopicHandlers(
    tidepoolHost,
    toolInfra,
    bootstrap,
    coreInfra,
    coordinatorState,
    chatSession.readSentinelDiscoverySource,
    chatSession.readSentinelTrafficDownloadPage,
    chatSession.readSentinelWorkerNarrative,
  );

  return tidepoolHost;
}

/** Start the Gateway WebSocket service. */
export async function launchGatewayService(
  toolInfra: ToolInfraResult,
  chatSession: ReturnType<typeof createChatSession>,
  coreInfra: CoreInfraResult,
  log: BootstrapResult["log"],
) {
  const gatewayChatSession = wrapChatSessionForGateway(
    chatSession,
    toolInfra.state,
    toolInfra.cliSecretPrompt,
    toolInfra.cliCredentialPrompt,
    toolInfra.cliConfirmPrompt,
  );
  const server = await startGatewayServer(
    gatewayChatSession,
    coreInfra.schedulerService,
    coreInfra.enhancedSessionManager,
    coreInfra.notificationService,
    log,
  );
  toolInfra.mcpBroadcastRefs.gatewayServer = server;
  return server;
}

/** Start Tidepool and Gateway servers, returning handles for shutdown. */
export async function startNetworkServices(
  bootstrap: BootstrapResult,
  coreInfra: CoreInfraResult,
  toolInfra: ToolInfraResult,
  chatSession: ReturnType<typeof createChatSession>,
  isTidepoolCallRef: { value: boolean },
  coordinatorState?: SentinelCoordinatorLookup,
) {
  const tidepoolHost = await launchTidepoolService(
    toolInfra,
    chatSession,
    isTidepoolCallRef,
    coreInfra.notificationService,
    bootstrap,
    coreInfra,
    coordinatorState,
  );
  const server = await launchGatewayService(
    toolInfra,
    chatSession,
    coreInfra,
    bootstrap.log,
  );
  // Populate deferred refs so onTriggerOutput can broadcast to all surfaces
  coreInfra.gatewayServerRef.value = server;
  coreInfra.tidepoolHostRef.value = tidepoolHost;
  return { tidepoolHost, server };
}

/** Log scheduler start status and trigger interval. */
function logSchedulerStart(
  schedulerService: ReturnType<typeof createSchedulerService>,
  schedulerConfig: ReturnType<typeof buildSchedulerConfig>,
  log: ReturnType<typeof createLogger>,
): void {
  schedulerService.start();
  log.info("Scheduler started");
  if (schedulerConfig.trigger.enabled) {
    log.info(`Trigger: every ${schedulerConfig.trigger.intervalMinutes}m`);
  }
  log.info("Triggerfish is running!");
}

/** Assemble shutdown dependency bag from service handles. */
export function assembleShutdownDeps(
  coreInfra: CoreInfraResult,
  toolInfra: ToolInfraResult,
  log: ReturnType<typeof createLogger>,
  signalDaemonState: Awaited<ReturnType<typeof wireMessageChannels>>,
  server: Awaited<ReturnType<typeof startGatewayServer>>,
  tidepoolHost: Awaited<ReturnType<typeof startTidepoolHost>>,
): ShutdownDeps {
  return {
    signalDaemonState,
    schedulerService: coreInfra.schedulerService,
    server,
    tidepoolHost,
    memoryDb: toolInfra.memoryDb,
    storage: coreInfra.storage,
    log,
  };
}

/** Build chat session and start Tidepool + Gateway servers. */
export async function startServicesAndChannels(
  bootstrap: BootstrapResult,
  coreInfra: CoreInfraResult,
  toolInfra: ToolInfraResult,
): Promise<ShutdownDeps> {
  const isTidepoolCallRef = { value: false };
  const isOwnerTurnRef = { value: true };
  const caseManagerRef: {
    current?: ReturnType<typeof startSentinelCaseManager>;
  } = {};
  const goalWorkflowMonitor: { stop?: () => void } = {};
  const chatSession = buildMainChatSession(
    bootstrap,
    coreInfra,
    toolInfra,
    isTidepoolCallRef,
    isOwnerTurnRef,
    () => caseManagerRef.current?.refresh(),
    goalWorkflowMonitor,
  );
  bootstrap.log.info("Main session created");
  toolInfra.mcpBroadcastRefs.chatSession = chatSession;

  const configuredAdmissionLimit = bootstrap.config.sentinel
    ?.assessment_concurrency;
  const releaseCaseAdmission = configuredAdmissionLimit !== undefined
    ? bindSentinelCaseAdmission(
      bootstrap.baseDir,
      (id, generation) =>
        caseManagerRef.current?.isAdmitted(id, generation) === true,
    )
    : undefined;
  const { tidepoolHost, server } = await startNetworkServices(
    bootstrap,
    coreInfra,
    toolInfra,
    chatSession,
    isTidepoolCallRef,
    (id) => caseManagerRef.current?.coordinatorState(id),
  ).catch((error) => {
    goalWorkflowMonitor.stop?.();
    releaseCaseAdmission?.();
    throw error;
  });
  const signalDaemonState = await wireMessageChannels(
    bootstrap.config,
    chatSession,
    coreInfra.notificationService,
    toolInfra.channelAdapters,
  );
  logSchedulerStart(
    coreInfra.schedulerService,
    coreInfra.schedulerConfig,
    bootstrap.log,
  );
  const shutdown = assembleShutdownDeps(
    coreInfra,
    toolInfra,
    bootstrap.log,
    signalDaemonState,
    server,
    tidepoolHost,
  );
  const topologySync = startSentinelTopologySync(
    bootstrap.baseDir,
    () =>
      bootstrap.log.warn(
        "Sentinel could not refresh a shared topology overlay",
      ),
  );
  const snapshotPath = sentinelSnapshotPath(bootstrap.baseDir);
  const webContainmentConfigured =
    bootstrap.config.web?.domains?.sentinel_containment === true;
  type AssessmentState = NonNullable<ReturnType<typeof readSentinelAssessment>>;
  const liveWorkflowReader = configuredSentinelWorkflowReader(
    bootstrap.config,
    bootstrap.baseDir,
    createKeychain,
  );
  const repositoryVisibilityReader =
    configuredSentinelRepositoryVisibilityReader(
      bootstrap.config,
      bootstrap.baseDir,
      createKeychain,
    );
  const authorizeSentinelExecutionEvidence =
    buildExecutionTracePayloadAuthorizer(
      bootstrap.config,
      toolInfra.mainKeychain,
    );
  const modelRouting = sentinelAssessmentModelRouting(
    toolInfra.registry,
    bootstrap.config.sentinel?.model_profile_allowlists,
  );
  const workerFactory = bootstrap.config.sentinel?.allow_model_access === true
    ? (casePath: string) =>
    (
      state: AssessmentState,
      assignedTaskId?: string,
      assignedTaskLeaseToken?: string,
      role?: "planner",
    ) =>
      createSentinelSubagent({
        ...modelRouting.workerOptions(
          state.plan.modelProfile,
          state.plan.runId
            ? {
              path: casePath,
              runId: state.plan.runId,
              revision: state.revision,
              role: role ?? "worker",
            }
            : undefined,
        ),
        hookRunner: toolInfra.hookRunner,
        snapshotPath: casePath,
        sharedInventoryBaseDir: bootstrap.baseDir,
        authorizeExecutionTracePayload: authorizeSentinelExecutionEvidence,
        plannerExecutionEvidenceRunId: role === "planner"
          ? state.plan.runId
          : undefined,
        snapshotOverride: state.result?.sharedGraph.snapshot,
        assessmentRevision: state.revision,
        assignedTaskId,
        assignedTaskLeaseToken,
        submitAssetDiscovery: assignedTaskId && assignedTaskLeaseToken
          ? ({ evidenceRevision, task, claim, requestId, signal }) =>
            Promise.resolve(
              signal.aborted || task.id !== assignedTaskId
                ? undefined
                : submitSentinelAssetDiscovery(
                  casePath,
                  {
                    taskId: assignedTaskId,
                    token: assignedTaskLeaseToken,
                    evidenceRevision,
                  },
                  claim,
                  requestId,
                ),
            )
          : undefined,
        readSharedAssetDiscoveries: assignedTaskId && assignedTaskLeaseToken
          ? ({ evidenceRevision, task, id, signal, after }) =>
            task.id === assignedTaskId
              ? readSentinelSharedAssetDiscoveries(
                casePath,
                {
                  taskId: assignedTaskId,
                  token: assignedTaskLeaseToken,
                  evidenceRevision,
                },
                id,
                signal,
                after,
              )
              : Promise.resolve([])
          : undefined,
        readRetainedWorkflow: liveWorkflowReader,
        readRepositoryVisibility: repositoryVisibilityReader,
        futureWorkflowScopes: bootstrap.config.sentinel?.github_workflow_reads,
        readLiveWorkflowStatus:
          liveWorkflowReader && assignedTaskId && assignedTaskLeaseToken
            ? ({ task, evidenceRevision, signal, authorize, resumeOnly }) => {
              const caseId = locateSentinelCase(casePath)?.caseId;
              if (
                !caseId || !task.nodeId || task.id !== assignedTaskId
              ) return Promise.resolve(undefined);
              const withStore = <T>(
                read: (
                  store: ReturnType<typeof openSentinelAdaptiveStore>,
                ) => T,
              ) => {
                const store = openSentinelAdaptiveStore(
                  join(dirname(casePath), "sentinel-adaptive.db"),
                );
                try {
                  return read(store);
                } finally {
                  store.close();
                }
              };
              return liveWorkflowReader({
                caseId,
                assetId: task.nodeId,
                evidenceRevision,
                signal,
                authorize,
                resumeOnly,
                loadSaved: () =>
                  withStore((store) =>
                    store.readLeasedGitHubWorkflowResult(
                      task.revision,
                      task.id,
                      assignedTaskLeaseToken,
                      evidenceRevision,
                    )
                  ),
                saveResult: (receipt) =>
                  withStore((store) =>
                    store.recordLeasedGitHubWorkflowResult(
                      task.revision,
                      task.id,
                      assignedTaskLeaseToken,
                      evidenceRevision,
                      receipt,
                    )
                  ),
                isCurrent: () =>
                  !!readAssignedSentinelModelReview(
                    casePath,
                    evidenceRevision,
                    assignedTaskId,
                    assignedTaskLeaseToken,
                  ),
              });
            }
            : undefined,
        onUsage(usage) {
          try {
            recordSentinelModelUsage(casePath, state.revision, usage);
          } catch {
            bootstrap.log.warn("Sentinel model usage could not be recorded");
          }
        },
        outputLanguage: bootstrap.config.sentinel?.output_language,
        readOutputLanguage: () =>
          readSentinelModelSettings(casePath)?.outputLanguage,
        webContainmentConfigured,
      })
    : undefined;
  const reserveModelWorker = createSentinelWorkerPool(
    bootstrap.config.sentinel?.model_worker_limit ?? 2,
  );
  const reserveMainWorker = () => reserveModelWorker(snapshotPath);
  const createWorker = workerFactory?.(snapshotPath);
  const modelPlanner = createWorker
    ? createSentinelModelPlanner(
      snapshotPath,
      createWorker,
      reserveMainWorker,
      Date.now,
      webContainmentConfigured,
      bootstrap.config.sentinel?.planner_heartbeat_seconds,
    )
    : undefined;
  const stopMainAdaptive = () => {
    reserveModelWorker.cancelWait(snapshotPath);
    modelPlanner?.stop();
  };
  const notifyIncidentIncrease =
    bootstrap.config.sentinel?.notify_incident_increases === true
      ? (caseId: string) => async (revision: number) => {
        let outcome: "delivered" | "queued" | undefined;
        await coreInfra.notificationService.deliver({
          userId: "owner" as UserId,
          classification: "INTERNAL",
          priority: "normal",
          sentinelReceipt: { caseId, revision },
          onImmediateOutcome: (state) => outcome = state,
          message:
            "Sentinel detected an increase in incident candidates. Review the assessment in Tidepool.",
        });
        return outcome;
      }
      : undefined;
  const sentinelAssessment = startSentinelAssessmentCoordinator({
    snapshotPath,
    webContainmentConfigured,
    notifyIncidentIncrease: notifyIncidentIncrease?.("main"),
    advanceAdaptive(state) {
      advanceAdaptiveSentinel(snapshotPath, state);
      modelPlanner?.advance(state);
    },
    createWorker,
    reserveWorker: reserveMainWorker,
    stopAdaptive: stopMainAdaptive,
    onError() {
      bootstrap.log.warn(
        "Sentinel assessment could not complete a refresh or review",
      );
    },
  });
  const caseManager = startSentinelCaseManager(
    bootstrap.baseDir,
    (casePath, caseId) => {
      const reserveCaseWorker = () => {
        if (caseManagerRef.current?.mayStartWork(caseId) !== false) {
          return reserveModelWorker(casePath);
        }
        reserveModelWorker.cancelWait(casePath);
      };
      const createCaseWorker = workerFactory?.(casePath);
      const planner = createCaseWorker
        ? createSentinelModelPlanner(
          casePath,
          createCaseWorker,
          reserveCaseWorker,
          Date.now,
          webContainmentConfigured,
          bootstrap.config.sentinel?.planner_heartbeat_seconds,
        )
        : undefined;
      const stopCaseAdaptive = () => {
        reserveModelWorker.cancelWait(casePath);
        planner?.stop();
      };
      const coordinator = startSentinelAssessmentCoordinator({
        snapshotPath: casePath,
        webContainmentConfigured,
        notifyIncidentIncrease: notifyIncidentIncrease?.(caseId),
        advanceAdaptive(state) {
          advanceAdaptiveSentinel(casePath, state);
          planner?.advance(state);
        },
        createWorker: createCaseWorker,
        reserveWorker: reserveCaseWorker,
        stopAdaptive: stopCaseAdaptive,
        onError() {
          bootstrap.log.warn("Named Sentinel assessment could not refresh");
        },
      });
      return {
        canYield: () =>
          !planner?.hasInFlightWork() && !coordinator.hasInFlightWork(),
        stop() {
          stopCaseAdaptive();
          coordinator.stop();
        },
      };
    },
    {
      concurrency: configuredAdmissionLimit,
      readConcurrency: configuredAdmissionLimit !== undefined
        ? () =>
          readSentinelAdmissionSettings(
            bootstrap.baseDir,
            configuredAdmissionLimit,
          ).effectiveLimit
        : undefined,
      isActiveCase: needsSentinelAssessmentCoordinator,
    },
  );
  caseManagerRef.current = caseManager;
  return {
    ...shutdown,
    sentinelAssessment: {
      stop() {
        topologySync.stop();
        goalWorkflowMonitor.stop?.();
        caseManager.stop();
        stopMainAdaptive();
        sentinelAssessment.stop();
      },
      releaseAdmission: releaseCaseAdmission,
    },
  };
}
