/** Assess defensive visibility by behavior, using imported Sentinel alert evidence. */

import { parseSentinelTelemetryAlert } from "./case_report.ts";
import type { TelemetryAlert } from "./telemetry.ts";

type Signal = TelemetryAlert["type"];
type SignalOrigin = "sentinel_rule" | "source_alert";

const signalOrigins: Record<Signal, SignalOrigin> = {
  authentication_failure_burst: "sentinel_rule",
  authentication_failure_fanout: "sentinel_rule",
  authentication_success_after_fanout: "sentinel_rule",
  authentication_success_after_failures: "sentinel_rule",
  privileged_authentication_without_mfa: "sentinel_rule",
  authorization_denial_burst: "sentinel_rule",
  egress_denied_burst: "sentinel_rule",
  web_multistage_activity: "sentinel_rule",
  integrity_change: "source_alert",
  endpoint_execution_alert: "source_alert",
  network_security_alert: "source_alert",
  cloud_security_alert: "source_alert",
  security_sensor_alert: "source_alert",
  unexpected_privilege_grant: "source_alert",
  unexpected_remote_access: "source_alert",
  sensitive_egress_alert: "source_alert",
};

interface Behavior {
  readonly id: string;
  readonly label: string;
  readonly coverage: "direct_signals" | "indirect_signals" | "gap";
  readonly signals: readonly Signal[];
  readonly limitation: string;
}

const behaviors: readonly Behavior[] = [
  {
    id: "reconnaissance",
    label: "Reconnaissance",
    coverage: "indirect_signals",
    signals: [
      "authorization_denial_burst",
      "network_security_alert",
      "web_multistage_activity",
    ],
    limitation:
      "Repeated authorization denials and ordered web activity can prompt investigation. Web sequences require collector-classified stages and a shared trusted session reference.",
  },
  {
    id: "exploitation",
    label: "Exploitation",
    coverage: "indirect_signals",
    signals: [
      "endpoint_execution_alert",
      "integrity_change",
      "network_security_alert",
    ],
    limitation:
      "Network and endpoint alerts can surface suspicious activity. The generic alert alone does not identify a vulnerability or establish successful exploitation.",
  },
  {
    id: "credential_abuse",
    label: "Credential abuse",
    coverage: "direct_signals",
    signals: [
      "authentication_failure_burst",
      "authentication_success_after_failures",
      "authentication_failure_fanout",
      "authentication_success_after_fanout",
      "privileged_authentication_without_mfa",
    ],
    limitation:
      "The rules show failures on one account or across accounts that share an authority-scoped source. Valid stolen credentials without failures or activity split across unrelated source references can escape detection.",
  },
  {
    id: "lateral_movement",
    label: "Lateral movement",
    coverage: "indirect_signals",
    signals: ["unexpected_remote_access"],
    limitation:
      "Visibility depends on the remote-access alert source. The alert alone cannot establish the prior host, session chain, or movement between assets.",
  },
  {
    id: "privilege_escalation",
    label: "Privilege escalation",
    coverage: "direct_signals",
    signals: ["unexpected_privilege_grant"],
    limitation:
      "Visibility depends on the privilege monitoring source. Escalation that leaves no reported grant or alert requires separate endpoint or audit evidence.",
  },
  {
    id: "persistence",
    label: "Persistence",
    coverage: "indirect_signals",
    signals: ["integrity_change"],
    limitation:
      "A source-reported integrity change identifies an observed change. Establishing persistence requires baselines and evidence for the specific resource or mechanism.",
  },
  {
    id: "exfiltration",
    label: "Exfiltration",
    coverage: "indirect_signals",
    signals: ["sensitive_egress_alert", "egress_denied_burst"],
    limitation:
      "DLP and denial alerts can surface suspicious or blocked transfers. These signals alone cannot establish transfer completion or visibility into other processes and protocols.",
  },
  {
    id: "host_indicators",
    label: "Host indicators",
    coverage: "direct_signals",
    signals: ["endpoint_execution_alert", "integrity_change"],
    limitation:
      "Visibility depends on the endpoint and integrity monitoring sources. An alert does not establish attribution or the state of unmonitored hosts.",
  },
];

export const sentinelUpstreamChecks = [
  {
    id: "cloudtrail_root_console_login_without_mfa",
    sigmaId: "3fe039b5-53f9-4287-b5ed-45defe3c0c61",
    type: "privileged_authentication_without_mfa",
    actions: ["signin.amazonaws.com:ConsoleLogin:root-without-mfa"],
    limitation:
      "CloudTrail reports a successful root console sign-in without MFA. Confirm whether the privileged access was expected and review subsequent account activity.",
  },
  {
    id: "cloudtrail_logging_stopped",
    sigmaId: "d2a85e6e-6baf-4134-92f2-554251cef28f",
    type: "integrity_change",
    actions: ["cloudtrail.amazonaws.com:StopLogging"],
    limitation:
      "The CloudTrail record reports a successful logging stop. It gives no visibility into actions after collection stops.",
  },
  {
    id: "cloudtrail_audit_configuration_changed",
    sigmaId: "6e658f59-0330-412a-9f41-6f11ac0d8518",
    type: "integrity_change",
    actions: [
      "cloudtrail.amazonaws.com:DeleteTrail",
      "cloudtrail.amazonaws.com:UpdateTrail",
      "cloudtrail.amazonaws.com:PutEventSelectors",
      "cloudtrail.amazonaws.com:PutInsightSelectors",
      "cloudtrail.amazonaws.com:StopEventDataStoreIngestion",
      "cloudtrail.amazonaws.com:DeleteEventDataStore",
      "cloudtrail.amazonaws.com:UpdateEventDataStore",
    ],
    limitation:
      "CloudTrail reports a successful change. Compare the resulting audit configuration with the approved baseline.",
  },
  {
    id: "kubernetes_rbac_binding_changed",
    sigmaId: "2482f28c-131f-46ed-88db-832aae967fd5",
    type: "integrity_change",
    actions: [
      "kubernetes-audit:rolebindings:create",
      "kubernetes-audit:rolebindings:update",
      "kubernetes-audit:rolebindings:patch",
      "kubernetes-audit:rolebindings:delete",
      "kubernetes-audit:rolebindings:deletecollection",
      "kubernetes-audit:clusterrolebindings:create",
      "kubernetes-audit:clusterrolebindings:update",
      "kubernetes-audit:clusterrolebindings:patch",
      "kubernetes-audit:clusterrolebindings:delete",
      "kubernetes-audit:clusterrolebindings:deletecollection",
    ],
    limitation:
      "Kubernetes reports a successful RBAC binding change. Review the binding, role, and subjects to establish the resulting access.",
  },
  {
    id: "kubernetes_rbac_role_changed",
    sigmaId: "c3e02795-5d2e-491c-bb31-81506bcda769",
    type: "integrity_change",
    actions: [
      "kubernetes-audit:roles:create",
      "kubernetes-audit:roles:update",
      "kubernetes-audit:roles:patch",
      "kubernetes-audit:roles:delete",
      "kubernetes-audit:roles:deletecollection",
      "kubernetes-audit:clusterroles:create",
      "kubernetes-audit:clusterroles:update",
      "kubernetes-audit:clusterroles:patch",
      "kubernetes-audit:clusterroles:delete",
      "kubernetes-audit:clusterroles:deletecollection",
    ],
    limitation:
      "Kubernetes reports a successful Role or ClusterRole request. Review the persisted rules and applicable bindings to determine effective permissions.",
  },
  {
    id: "kubernetes_network_policy_changed",
    sigmaId: "7c4d384a-8249-4781-9d8f-02be31707d76",
    type: "integrity_change",
    actions: [
      "kubernetes-audit:networkpolicies:create",
      "kubernetes-audit:networkpolicies:update",
      "kubernetes-audit:networkpolicies:patch",
      "kubernetes-audit:networkpolicies:delete",
      "kubernetes-audit:networkpolicies:deletecollection",
    ],
    limitation:
      "Kubernetes reports a successful NetworkPolicy request. Confirm the persisted policy, other policies that select the workloads, and enforcement by the network plugin.",
  },
  {
    id: "kubernetes_validating_webhook_configuration_changed",
    sigmaId: "2b210958-d2c1-4d5b-bfa0-fe9d28142741",
    type: "integrity_change",
    actions: [
      "kubernetes-audit:validatingwebhookconfigurations:create",
      "kubernetes-audit:validatingwebhookconfigurations:update",
      "kubernetes-audit:validatingwebhookconfigurations:patch",
      "kubernetes-audit:validatingwebhookconfigurations:delete",
      "kubernetes-audit:validatingwebhookconfigurations:deletecollection",
    ],
    limitation:
      "Kubernetes reports a successful ValidatingWebhookConfiguration request. Review the persisted configuration and matching rules to establish the effect on admission.",
  },
  {
    id: "kubernetes_mutating_webhook_configuration_changed",
    sigmaId: "29b0d19b-9170-4a57-9718-e232327814d1",
    type: "integrity_change",
    actions: [
      "kubernetes-audit:mutatingwebhookconfigurations:create",
      "kubernetes-audit:mutatingwebhookconfigurations:update",
      "kubernetes-audit:mutatingwebhookconfigurations:patch",
      "kubernetes-audit:mutatingwebhookconfigurations:delete",
      "kubernetes-audit:mutatingwebhookconfigurations:deletecollection",
    ],
    limitation:
      "Kubernetes reports a successful MutatingWebhookConfiguration request. Review the persisted configuration and matching rules to establish the effect on admission.",
  },
  {
    id: "kubernetes_validating_admission_policy_changed",
    sigmaId: "0b9b87c8-b832-417e-b197-379bf6553c27",
    type: "integrity_change",
    actions: [
      "kubernetes-audit:validatingadmissionpolicies:create",
      "kubernetes-audit:validatingadmissionpolicies:update",
      "kubernetes-audit:validatingadmissionpolicies:patch",
      "kubernetes-audit:validatingadmissionpolicies:delete",
      "kubernetes-audit:validatingadmissionpolicies:deletecollection",
    ],
    limitation:
      "Kubernetes reports a successful ValidatingAdmissionPolicy request. Review the persisted expressions, failure policy, and active bindings to determine the effect.",
  },
  {
    id: "kubernetes_validating_admission_policy_binding_changed",
    sigmaId: "366e565b-76ce-4e78-8e15-b6884c1e678b",
    type: "integrity_change",
    actions: [
      "kubernetes-audit:validatingadmissionpolicybindings:create",
      "kubernetes-audit:validatingadmissionpolicybindings:update",
      "kubernetes-audit:validatingadmissionpolicybindings:patch",
      "kubernetes-audit:validatingadmissionpolicybindings:delete",
      "kubernetes-audit:validatingadmissionpolicybindings:deletecollection",
    ],
    limitation:
      "Kubernetes reports a successful ValidatingAdmissionPolicyBinding request. Review the affected policy, selected resources, and validation actions to determine which requests are now checked.",
  },
  {
    id: "cloudtrail_cloudwatch_log_group_deleted",
    sigmaId: "8d91ccce-40ad-4738-8e45-ed28e67d0728",
    type: "integrity_change",
    actions: ["logs.amazonaws.com:DeleteLogGroup"],
    limitation:
      "CloudTrail reports deletion of a CloudWatch Logs group. Check its former retention, delivery, and any independent copies to determine the affected evidence.",
  },
  {
    id: "cloudtrail_cloudwatch_log_stream_deleted",
    sigmaId: "4c0389ca-9e35-42d9-9bb4-e7ba92e33787",
    type: "integrity_change",
    actions: ["logs.amazonaws.com:DeleteLogStream"],
    limitation:
      "CloudTrail reports deletion of a CloudWatch Logs stream and its retained events. Check independent copies to determine which evidence is still available.",
  },
  {
    id: "cloudtrail_cloudwatch_subscription_filter_deleted",
    sigmaId: "529e550f-3ff8-4731-a20f-a4999f1be142",
    type: "integrity_change",
    actions: ["logs.amazonaws.com:DeleteSubscriptionFilter"],
    limitation:
      "CloudTrail reports deletion of a CloudWatch Logs subscription filter. Check the affected destination and other subscriptions to determine which downstream evidence stopped arriving.",
  },
  {
    id: "cloudtrail_cloudwatch_subscription_filter_written",
    sigmaId: "5074c532-3ca7-4dc5-a17c-2f45818cd216",
    type: "integrity_change",
    actions: ["logs.amazonaws.com:PutSubscriptionFilter"],
    limitation:
      "CloudTrail reports creation or replacement of a CloudWatch Logs subscription filter. Compare the configured destination and selection against the approved baseline to determine the effect.",
  },
  {
    id: "cloudtrail_iam_policy_changed",
    sigmaId: "e4b4482f-fe50-4f96-adf2-bd7a514dd894",
    type: "integrity_change",
    actions: [
      "iam.amazonaws.com:AttachGroupPolicy",
      "iam.amazonaws.com:AttachRolePolicy",
      "iam.amazonaws.com:AttachUserPolicy",
      "iam.amazonaws.com:DetachGroupPolicy",
      "iam.amazonaws.com:DetachRolePolicy",
      "iam.amazonaws.com:DetachUserPolicy",
      "iam.amazonaws.com:PutGroupPolicy",
      "iam.amazonaws.com:PutRolePolicy",
      "iam.amazonaws.com:PutUserPolicy",
      "iam.amazonaws.com:DeleteGroupPolicy",
      "iam.amazonaws.com:DeleteRolePolicy",
      "iam.amazonaws.com:DeleteUserPolicy",
      "iam.amazonaws.com:SetDefaultPolicyVersion",
      "iam.amazonaws.com:UpdateAssumeRolePolicy",
    ],
    limitation:
      "CloudTrail reports a successful IAM policy change. Review the policy and affected identities to establish the resulting access.",
  },
  {
    id: "cloudtrail_iam_account_password_policy_changed",
    sigmaId: "e47f3ced-6408-4e7d-a19b-9fecab3ee478",
    type: "integrity_change",
    actions: [
      "iam.amazonaws.com:DeleteAccountPasswordPolicy",
      "iam.amazonaws.com:UpdateAccountPasswordPolicy",
    ],
    limitation:
      "CloudTrail reports removal or replacement of the account's IAM password policy. Compare the effective policy with the approved baseline to assess any reduction in protection.",
  },
  {
    id: "cloudtrail_iam_mfa_device_deactivated",
    sigmaId: "3e6379d8-7138-4397-b505-0e405b91473c",
    type: "integrity_change",
    actions: ["iam.amazonaws.com:DeactivateMFADevice"],
    limitation:
      "CloudTrail reports deactivation of an IAM MFA device. Verify the identity's remaining registered factors and the approved change history.",
  },
  {
    id: "cloudtrail_iam_access_key_created",
    sigmaId: "5138b0ea-d7ef-4cb3-977c-c6078ac0f320",
    type: "integrity_change",
    actions: ["iam.amazonaws.com:CreateAccessKey"],
    limitation:
      "CloudTrail reports successful access key creation. Review whether the credential was authorized and how it is managed.",
  },
  {
    id: "cloudtrail_iam_access_key_set_active",
    sigmaId: "965fbdd8-ca58-400e-ab5a-30337617afd8",
    type: "integrity_change",
    actions: ["iam.amazonaws.com:UpdateAccessKey:active"],
    limitation:
      "CloudTrail reports a successful request to set an access key to Active. Review the approval and the key's status history.",
  },
  {
    id: "entra_directory_role_granted",
    sigmaId: "15c8f48e-8522-421f-b654-08c3d34095da",
    type: "unexpected_privilege_grant",
    actions: [
      "entra.directory_role.add_member",
      "entra.directory_role.add_scoped_member",
      "entra.directory_role.add_restricted_scope_member",
    ],
    limitation:
      "Entra reports a successful directory role grant. Review the grantee, role, scope, and approval to establish its significance.",
  },
  {
    id: "entra_conditional_access_policy_changed",
    sigmaId: "dd33a9fc-9b9f-485d-95d5-9ffedfb77ad1",
    type: "integrity_change",
    actions: [
      "entra.conditional_access.policy_update",
      "entra.conditional_access.policy_delete",
    ],
    limitation:
      "Entra reports a successful update or deletion. Compare the policy scope and resulting access with the approved configuration.",
  },
  {
    id: "entra_authentication_policy_changed",
    sigmaId: "85c2d1fc-7753-4752-a712-b5a4cacbbec8",
    type: "integrity_change",
    actions: [
      "entra.authentication.methods_reset",
      "entra.authentication.methods_update",
      "entra.authentication.strength_delete",
      "entra.authentication.strength_update",
      "entra.authentication.security_defaults_update",
    ],
    limitation:
      "Entra reports a successful authentication policy or security defaults change. Effective authentication requirements and approval require separate evidence.",
  },
  {
    id: "entra_service_principal_credentials_added",
    sigmaId: "1b20958e-3596-40de-b471-46cc1ae0bcc5",
    type: "integrity_change",
    actions: ["entra.service_principal.credentials_added"],
    limitation:
      "Entra reports a successful service principal credential addition. Review the authorized change and later sign-in evidence separately.",
  },
  {
    id: "entra_service_principal_credentials_removed",
    sigmaId: "29a78ed0-b091-481f-8f48-1b888b9611d8",
    type: "integrity_change",
    actions: ["entra.service_principal.credentials_removed"],
    limitation:
      "Entra reports a successful service principal credential removal. The event cannot establish which other credentials remain valid.",
  },
  {
    id: "entra_application_credentials_changed",
    sigmaId: "a9ce7a97-ebb9-4fb6-9b21-02eb6b6b0f38",
    type: "integrity_change",
    actions: ["entra.application.credentials_changed"],
    limitation:
      "Entra reports a successful certificate or secret management change. This audit action does not distinguish additions, rotations, and removals.",
  },
  {
    id: "entra_application_app_only_permission_granted",
    sigmaId: "44cd9450-1f23-4ff8-9097-cc8d122e1f05",
    type: "integrity_change",
    actions: ["entra.application.app_only_permission_granted"],
    limitation:
      "Entra reports a successful app-only role assignment. Review the recipient service principal, resource, role, and authorization to establish the scope of access.",
  },
  {
    id: "entra_application_delegated_permission_granted",
    sigmaId: "093668d1-df6f-43cc-8d7a-871d5fb843d8",
    type: "integrity_change",
    actions: ["entra.application.delegated_permission_granted"],
    limitation:
      "Entra reports a successful delegated permission grant. Review the application, affected users, resource, granted scopes, and authorization.",
  },
  {
    id: "entra_application_consent_granted",
    sigmaId: "370381d4-bb97-4b1d-ad4d-b27df00a0b8e",
    type: "integrity_change",
    actions: ["entra.application.consent_granted"],
    limitation:
      "Entra reports a successful application consent activity. Review the application, who consented, and the resulting permissions to determine the impact.",
  },
  {
    id: "windows_privileged_group_grant",
    sigmaId: "45af047f-a69b-4d99-87dc-14ba4327af16",
    type: "unexpected_privilege_grant",
    actions: ["winlog:4728", "winlog:4732", "winlog:4756"],
    limitation:
      "Windows reports an addition to a recognized or configured privileged group. Approvals and subsequent use require separate evidence.",
  },
  {
    id: "windows_scheduled_task_created_or_updated",
    sigmaId: "32ff65aa-d11a-456b-ba3a-370eb1f4fd30",
    type: "integrity_change",
    actions: ["winlog:4698", "winlog:4702"],
    limitation:
      "Windows reports creation or update of a scheduled task. Compare the task configuration with approved changes and use separate execution evidence to determine whether it ran.",
  },
  {
    id: "windows_service_installed",
    sigmaId: "cead5a95-5d49-45f6-a0aa-1248e61e8c53",
    type: "integrity_change",
    actions: ["winlog:4697"],
    limitation:
      "Windows reports installation of a new service. Compare the installation with authorized changes and review its current configuration to assess persistence.",
  },
  {
    id: "zeek_ssh_password_guessing_notice",
    sigmaId: "d8bcc4dc-cad2-49dd-b2da-77399969de8d",
    type: "network_security_alert",
    actions: ["zeek:SSH::Password_Guessing"],
    limitation:
      "The Zeek SSH notice reports suspected password guessing in monitored traffic. It does not establish a successful login.",
  },
  {
    id: "windows_auditing_removed",
    sigmaId: "3f4d5e6c-46c7-43b8-93fe-a50dda85d116",
    type: "integrity_change",
    actions: [
      "winlog:4719:success-and-failure-removed",
      "winlog:4719:success-removed",
      "winlog:4719:failure-removed",
    ],
    limitation:
      "Windows reports that audit policy categories were removed. The record alone does not establish intent or later activity.",
  },
  {
    id: "windows_security_log_cleared",
    sigmaId: "889ab9d1-3707-429f-8e91-4a976fcb7b76",
    type: "integrity_change",
    actions: ["winlog:1102"],
    limitation:
      "Windows reports that the Security audit log was cleared. The event does not establish intent or recover cleared records.",
  },
  {
    id: "windows_security_log_full",
    sigmaId: "ccbe8332-63d1-4ca9-98de-3fa4abf3ada5",
    type: "integrity_change",
    actions: ["winlog:1104"],
    limitation:
      "Windows reports that its Security log reached capacity. Check log retention and forwarding health to establish whether audit records are missing.",
  },
  {
    id: "windows_security_log_processing_error",
    sigmaId: "6a56da0e-58d5-43df-b4fe-d500868b8d82",
    type: "integrity_change",
    actions: ["winlog:1108"],
    limitation:
      "Windows reports an error processing an incoming event. Correlate nearby records and forwarding health to determine the cause and impact.",
  },
  {
    id: "windows_system_clock_changed",
    sigmaId: "15bafef1-433d-4b53-a7e2-0e4f50ac5fe9",
    type: "integrity_change",
    actions: ["winlog:4616"],
    limitation:
      "Windows reports a system time change by an account other than Local Service. Investigate the reason and corroborate timestamps across sources.",
  },
  {
    id: "windows_exploit_protection_block",
    sigmaId: "c1285a23-1c8d-4087-9073-6f6fe1f575ea",
    type: "security_sensor_alert",
    actions: [
      "winlog:mitigation:2",
      "winlog:mitigation:4",
      "winlog:mitigation:6",
      "winlog:mitigation:8",
      "winlog:mitigation:10",
      "winlog:mitigation:12",
      "winlog:mitigation:14",
      "winlog:mitigation:16",
      "winlog:mitigation:18",
      "winlog:mitigation:20",
      "winlog:mitigation:22",
      "winlog:mitigation:24",
      "winlog:mitigation:5",
      "winlog:mitigation:260",
    ],
    limitation:
      "Windows reports an enforced mitigation. Investigate the application and host for context and related activity.",
  },
  {
    id: "defender_controlled_folder_access_block",
    sigmaId: "d3f110f7-7c7d-41de-9047-cd98779cce1e",
    type: "security_sensor_alert",
    actions: ["defender:1123", "defender:1127"],
    limitation:
      "Defender reports a Controlled Folder Access block. Investigate the affected application and related host activity.",
  },
  {
    id: "defender_real_time_protection_disabled",
    sigmaId: "113dbd7c-6202-4fa9-92bb-a3a6a1397d09",
    type: "integrity_change",
    actions: ["defender:5001"],
    limitation:
      "Defender reports that real-time protection was disabled. Review the configuration and any later re-enablement.",
  },
  {
    id: "defender_scanning_disabled",
    sigmaId: "c397549d-c709-472c-bb82-b710155d9d6c",
    type: "integrity_change",
    actions: ["defender:5010", "defender:5012"],
    limitation:
      "Defender reports that malware or virus scanning was disabled. Verify the subsequent protection state and any replacement coverage.",
  },
  {
    id: "defender_protection_expired",
    sigmaId: "fee6acdd-81f1-4635-980f-a17b7586733c",
    type: "integrity_change",
    actions: ["defender:5101"],
    limitation:
      "Defender reports that its protection expired. Verify the endpoint's current protection state and whether it remained monitored.",
  },
  {
    id: "defender_remediation_failed",
    sigmaId: "c4db7754-3b3c-4af9-b140-59528fa449c6",
    type: "security_sensor_alert",
    actions: ["defender:1118", "defender:1119"],
    limitation:
      "Defender reports a failed remediation attempt. Review the host and later events to determine whether the threat remains.",
  },
  {
    id: "defender_malware_detected",
    sigmaId: "d2bcecb9-b912-486f-8ef6-7b2e4b217ba2",
    type: "security_sensor_alert",
    actions: ["defender:1116"],
    limitation:
      "Defender reports a threat detection. Review subsequent response events to learn how the threat was handled.",
  },
  {
    id: "defender_attack_surface_reduction_block",
    sigmaId: "82debe6f-5861-43fd-aa36-4a8f887e078c",
    type: "security_sensor_alert",
    actions: ["defender:1121"],
    limitation:
      "Defender reports an Attack Surface Reduction rule block. The event identifies the enforcement outcome for that action.",
  },
  {
    id: "defender_network_block",
    sigmaId: "e18b74a3-45f1-4c0e-8266-c386f9fa1549",
    type: "network_security_alert",
    actions: ["defender:1126"],
    limitation:
      "Defender reports a network protection block. The alert alone does not establish whether other traffic succeeded.",
  },
  {
    id: "defender_tamper_protection_block",
    sigmaId: "eb9da8cd-015c-4326-a739-ce305e5efe16",
    type: "security_sensor_alert",
    actions: ["defender:5013"],
    limitation:
      "Defender reports that it blocked a settings change. The event does not establish the actor's intent or whether another change succeeded.",
  },
  {
    id: "cloudtrail_guardduty_detector_reduced",
    sigmaId: "96d4c938-b9cf-4be0-85bb-9225999535bf",
    type: "integrity_change",
    actions: [
      "guardduty.amazonaws.com:DeleteDetector",
      "guardduty.amazonaws.com:UpdateDetector:disabled",
    ],
    limitation:
      "CloudTrail reports that an individual regional GuardDuty detector was disabled or deleted. Verify the affected account and Region before assessing remaining detection coverage.",
  },
  {
    id: "cloudtrail_config_recorder_reduced",
    sigmaId: "57bdbee3-3bed-4e05-9774-599e1f7e18c7",
    type: "integrity_change",
    actions: [
      "config.amazonaws.com:StopConfigurationRecorder",
      "config.amazonaws.com:DeleteConfigurationRecorder",
      "config.amazonaws.com:DeleteServiceLinkedConfigurationRecorder",
    ],
    limitation:
      "CloudTrail reports that an AWS Config recorder was stopped or deleted. Use the recorder's prior resource scope to determine which changes may no longer be recorded.",
  },
  {
    id: "cloudtrail_security_hub_disabled",
    sigmaId: "45793d36-a223-4e4a-9c1e-89cdaf8358e3",
    type: "integrity_change",
    actions: ["securityhub.amazonaws.com:DisableSecurityHub"],
    limitation:
      "CloudTrail reports a successful request to disable Security Hub CSPM. Verify the affected account and Region and confirm the current service state.",
  },
  {
    id: "cloudtrail_security_hub_standards_disable_requested",
    sigmaId: "6afb6751-cd64-4c1a-b21a-c17bce85d042",
    type: "integrity_change",
    actions: ["securityhub.amazonaws.com:BatchDisableStandards"],
    limitation:
      "CloudTrail reports a successful request to disable standards. Review subscription status and other enabled standards to establish the resulting control coverage.",
  },
  {
    id: "cloudtrail_kms_key_policy_changed",
    sigmaId: "a3128e31-af15-4ccb-8ca7-2afe61f8eb3d",
    type: "integrity_change",
    actions: ["kms.amazonaws.com:PutKeyPolicy"],
    limitation:
      "CloudTrail reports a successful request to write a KMS key policy. Compare the policy before and after the change and review applicable grants and IAM policies to assess effective access.",
  },
  {
    id: "cloudtrail_kms_key_disabled",
    sigmaId: "274e1fb1-d5de-4203-84d8-85af1fcf7da4",
    type: "integrity_change",
    actions: ["kms.amazonaws.com:DisableKey"],
    limitation:
      "CloudTrail reports a successful request to disable a KMS key. Confirm the current key state and which resources depend on it.",
  },
  {
    id: "cloudtrail_kms_key_deletion_scheduled",
    sigmaId: "1edafd3c-e271-4900-8b0f-0728b74b9bf4",
    type: "integrity_change",
    actions: ["kms.amazonaws.com:ScheduleKeyDeletion"],
    limitation:
      "CloudTrail reports that a request to schedule KMS key deletion succeeded. Verify the current key state, deletion schedule, and dependent resources.",
  },
  {
    id: "cloudtrail_s3_account_public_access_block_changed",
    sigmaId: "4eb9bc32-2e77-43d5-9d4f-5f9cd63819eb",
    type: "integrity_change",
    actions: [
      "s3.amazonaws.com:PutAccountPublicAccessBlock",
      "s3.amazonaws.com:DeleteAccountPublicAccessBlock",
    ],
    limitation:
      "CloudTrail reports a successful account-level S3 Block Public Access change. Review the resulting account, organization, and affected bucket settings to establish effective public access.",
  },
  {
    id: "cloudtrail_s3_bucket_public_access_block_removed",
    sigmaId: "83b23447-a4f5-405b-83da-cd60f12c17ff",
    type: "integrity_change",
    actions: ["s3.amazonaws.com:DeleteBucketPublicAccessBlock"],
    limitation:
      "CloudTrail reports a successful request to remove a bucket's Block Public Access configuration. Verify the bucket policy and effective account and organization settings to assess public access.",
  },
  {
    id: "cloudtrail_ebs_snapshot_public_access_block_disabled",
    sigmaId: "ad5de709-d21b-4e60-ae73-52c9f546c2d0",
    type: "integrity_change",
    actions: ["ec2.amazonaws.com:DisableSnapshotBlockPublicAccess"],
    limitation:
      "CloudTrail reports a successful request to disable the regional account-level block for public EBS snapshot access. Review the current setting and individual snapshot permissions.",
  },
  {
    id: "cloudtrail_ami_public_access_block_disabled",
    sigmaId: "fcd12bf6-ce1f-4951-a250-7869aa210499",
    type: "integrity_change",
    actions: ["ec2.amazonaws.com:DisableImageBlockPublicAccess"],
    limitation:
      "CloudTrail reports a successful request to disable the regional account-level block for public AMI sharing. Review the current setting and individual AMI launch permissions.",
  },
  {
    id: "cloudtrail_macie_monitoring_reduced",
    sigmaId: "55679e91-f84a-4a61-94c9-3002783db498",
    type: "integrity_change",
    actions: [
      "macie2.amazonaws.com:DisableMacie",
      "macie2.amazonaws.com:UpdateMacieSession:paused",
    ],
    limitation:
      "CloudTrail reports a successful request to disable or pause regional Macie monitoring. Confirm the affected account and Region and check whether monitoring has resumed.",
  },
] satisfies readonly {
  id: string;
  sigmaId: string;
  type: Signal;
  actions: readonly string[];
  limitation: string;
}[];

export function matchesSentinelUpstreamCheck(
  check: typeof sentinelUpstreamChecks[number],
  alert: TelemetryAlert,
): boolean {
  return alert.type === check.type && alert.triggeringAction !== undefined &&
    check.actions.includes(alert.triggeringAction);
}

export interface SentinelDefenseCoverageOptions {
  readonly alerts?: readonly unknown[];
  /** Gateway configuration status as reported by the caller. */
  readonly webContainmentConfigured?: boolean;
}

/** Describe installed signal capabilities separately from evidence in an alert set. */
export function assessSentinelDefenseCoverage(
  options: SentinelDefenseCoverageOptions = {},
) {
  type Evidence = {
    sourceRecord: number;
    asset: string;
    observedAt: string;
    evidenceIds: readonly string[];
  };
  const evidenceBySignal = new Map<Signal, Evidence[]>();
  const evidenceByCheck = new Map<string, Evidence[]>();
  for (const [index, raw] of (options.alerts ?? []).entries()) {
    const sourceRecord = index + 1;
    const alert = parseSentinelTelemetryAlert(raw, sourceRecord);
    const evidence = {
      sourceRecord,
      asset: alert.asset,
      observedAt: alert.observedAt,
      evidenceIds: alert.evidenceIds,
    };
    for (const check of sentinelUpstreamChecks) {
      if (!matchesSentinelUpstreamCheck(check, alert)) continue;
      const records = evidenceByCheck.get(check.id) ?? [];
      records.push(evidence);
      evidenceByCheck.set(check.id, records);
    }
    const existing = evidenceBySignal.get(alert.type);
    if (existing) existing.push(evidence);
    else evidenceBySignal.set(alert.type, [evidence]);
  }

  return {
    version: 1,
    webContainment: {
      status: options.webContainmentConfigured === undefined
        ? "unknown"
        : options.webContainmentConfigured
        ? "configured"
        : "disabled",
      scope:
        "Exact destination host blocks on supported Triggerfish web fetches. Configuration status does not verify that the gateway is running, a block is active, or other processes and protocols are covered.",
    },
    upstreamChecks: sentinelUpstreamChecks.map((check) => ({
      ...check,
      records: evidenceByCheck.get(check.id) ?? [],
    })),
    supplementalSignals:
      (["cloud_security_alert", "security_sensor_alert"] as const)
        .map((type) => ({
          type,
          origin: signalOrigins[type],
          records: evidenceBySignal.get(type) ?? [],
        })),
    behaviors: behaviors.map(({ signals, ...behavior }) => {
      const evidence = signals.map((type) => ({
        type,
        origin: signalOrigins[type],
        records: evidenceBySignal.get(type) ?? [],
      }));
      const alertCount = evidence.reduce(
        (total, { records }) => total + records.length,
        0,
      );
      return {
        ...behavior,
        evidenceStatus: options.alerts === undefined
          ? "not_provided"
          : alertCount > 0
          ? "signals_observed"
          : "none_observed",
        alertCount,
        signals: evidence,
      };
    }),
    interpretation:
      "Coverage describes available signal types, and evidence links refer to the supplied alert records. Alerts require investigation. This assessment does not verify attack attribution or guarantee detection or containment.",
  };
}
