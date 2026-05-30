#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

type SmokeCheckStatus = "pass" | "fail" | "warn";

export const REQUIRED_FEISHU_LOG_FIELDS: Record<string, readonly string[]> = {
  "chat.platform.starting": ["platform", "source", "groupMessageMode", "startupRequired"],
  "chat.platform.ready": ["platform", "source", "groupMessageMode", "durationMs"],
  "chat.platform.degraded": ["platform", "source", "groupMessageMode", "degradedReason"],
  "chat.message.ignored": [
    "platform",
    "conversationId",
    "conversationKind",
    "messageId",
    "eventId",
    "senderKind",
    "ignoredReason",
    "route"
  ],
  "chat.message.accepted": [
    "platform",
    "conversationId",
    "conversationKind",
    "rootMessageId",
    "messageId",
    "eventId",
    "senderKind",
    "msgType",
    "route"
  ],
  "chat.message.deduped": ["platform", "conversationId", "messageId", "eventId", "route"],
  "chat.session.created": ["platform", "sessionKey", "conversationId", "rootMessageId", "messageId", "groupMessageMode"],
  "chat.session.resumed": ["platform", "sessionKey", "conversationId", "rootMessageId", "messageId"],
  "chat.history.recovered": [
    "platform",
    "sessionKey",
    "conversationId",
    "rootMessageId",
    "messageCursor",
    "recoveredCount",
    "durationMs"
  ],
  "chat.turn.started": ["platform", "sessionKey", "turnId", "codexThreadId", "messageId", "batchId"],
  "chat.turn.steered": ["platform", "sessionKey", "turnId", "messageId", "batchId"],
  "chat.turn.stopped": ["platform", "sessionKey", "conversationId", "rootMessageId", "messageId", "turnId", "hadActiveTurn"],
  "chat.turn.completed": ["platform", "sessionKey", "turnId", "codexThreadId", "durationMs", "batchId"],
  "chat.outbound.posted": ["platform", "sessionKey", "conversationId", "rootMessageId", "format", "durationMs"],
  "chat.outbound.failed": [
    "platform",
    "sessionKey",
    "conversationId",
    "rootMessageId",
    "format",
    "errorClass",
    "statusCode",
    "attempt"
  ],
  "chat.handler.failed": ["platform", "handler", "errorClass"],
  "chat.card.callback.received": [
    "platform",
    "sessionKey",
    "conversationId",
    "rootMessageId",
    "eventId",
    "messageId",
    "payloadRef",
    "ackDurationMs"
  ],
  "chat.attachment.download_failed": [
    "platform",
    "sessionKey",
    "conversationId",
    "rootMessageId",
    "messageId",
    "attachmentId",
    "kind",
    "errorClass"
  ],
  "chat.coauthor.confirmed": [
    "platform",
    "sessionKey",
    "conversationId",
    "rootMessageId",
    "candidateRevision",
    "confirmedCount"
  ]
};

const FORBIDDEN_INFO_WARN_META_KEYS = new Set([
  "appsecret",
  "authorization",
  "content",
  "displayname",
  "email",
  "headers",
  "rawcard",
  "rawmessage",
  "rawpayload",
  "token",
  "text"
]);

const FORBIDDEN_SETUP_EVIDENCE_KEYS = new Set([
  "accesskey",
  "accesstoken",
  "appid",
  "appkey",
  "appsecret",
  "authorization",
  "bearertoken",
  "body",
  "botid",
  "botopenid",
  "botunionid",
  "botuserid",
  "clientsecret",
  "content",
  "email",
  "encryptkey",
  "message",
  "messagebody",
  "messagecontent",
  "messages",
  "openid",
  "password",
  "payload",
  "privatekey",
  "rawbody",
  "rawbotid",
  "rawid",
  "rawmessage",
  "rawpayload",
  "rawopenid",
  "rawunionid",
  "rawuserid",
  "refreshtoken",
  "secret",
  "tenantaccesstoken",
  "tenantaccesskey",
  "tenanttoken",
  "token",
  "unionid",
  "useremail",
  "userid",
  "verificationtoken"
]);

const FEISHU_SMOKE_SAFE_LOG_META_FIELDS = new Set([
  ...Object.values(REQUIRED_FEISHU_LOG_FIELDS).flat(),
  "fileId",
  "jobId",
  "payloadRef",
  "permission"
]);

const SAFE_FEISHU_SMOKE_LOG_TOKEN = /^[a-z][a-z0-9_.:-]*$/u;
const SAFE_FEISHU_SMOKE_SESSION_TOKEN = /^[a-zA-Z0-9_.:-]+$/u;
const SAFE_FEISHU_SMOKE_LOG_TIMESTAMP = /^[0-9TZ:.+-]+$/u;

const SECRET_LIKE_SETUP_EVIDENCE_VALUE =
  /\b(?:xox[abprs]-|xapp-|Bearer\s+\S+|(?:ou|on|oc|om|cli)_[A-Za-z0-9_-]{6,}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/iu;

const PLACEHOLDER_LIKE_SETUP_EVIDENCE_VALUE =
  /\b(?:example|placeholder|replace\b|todo\b|tbd\b|fill\b|copy this file)\b|approval ticket, reviewer, or console screenshot reference|^approval ticket$|bot\/app information page(?: showing)?/iu;

const SETUP_PERMISSION_POSTURE_REQUIREMENTS = [
  {
    key: "sendMessage",
    label: "send_message",
    apiField: "apiName",
    allowedApiNames: ["im:message:send_as_bot", "im:message"],
    allowedStatuses: ["approved", "configured"],
    evidenceField: "evidence"
  },
  {
    key: "cardCallback",
    label: "card.action.trigger",
    apiField: "eventName",
    allowedApiNames: ["card.action.trigger"],
    allowedStatuses: ["enabled", "configured", "approved"],
    evidenceField: "evidence"
  },
  {
    key: "resourceTransfer",
    label: "resource_transfer",
    apiField: "scopeName",
    allowedApiNames: undefined,
    allowedStatuses: ["approved", "configured"],
    evidenceField: "evidence"
  }
] as const;

const SECRET_LIKE_INFO_WARN_META_VALUE =
  /\b(?:xox[abprs]-[A-Za-z0-9_-]+|xapp-[A-Za-z0-9_-]+|Bearer\s+\S+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/iu;

const SECRET_LIKE_SMOKE_REPORT_EVIDENCE_VALUE =
  /\b(?:xox[abprs]-[A-Za-z0-9_-]+|xapp-[A-Za-z0-9_-]+|Bearer\s+\S+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/giu;

const SENTINEL_LIKE_SMOKE_REPORT_EVIDENCE_VALUE =
  /\b[A-Z0-9_]*(?:SECRET|BODY|PAYLOAD)[A-Z0-9_]*\b/gu;

const SAFE_SMOKE_REPORT_EVIDENCE_LITERALS = [
  "FEISHU_APP_SECRET"
] as const;

const FEISHU_PLATFORM_DEGRADED_REASONS = new Set([
  "all_message_delivery_unverified",
  "connection_closed",
  "connection_failed",
  "group_message_all_unavailable",
  "startup_failed"
]);
const FEISHU_HANDLER_NAMES = new Set(["message", "interactive"]);
const SMOKE_PLATFORM_HEALTH_STATES = new Set(["disabled", "starting", "ready", "degraded", "failed"]);
const SMOKE_PLATFORM_CONNECTION_MODES = new Set(["socket_mode", "long_connection", "http"]);
const SMOKE_FEISHU_GROUP_MESSAGE_MODES = new Set(["all", "at_only"]);
const SMOKE_PERMISSION_STATUSES = new Set(["unknown", "configured", "verified", "missing"]);
const SMOKE_SESSION_PLATFORMS = new Set(["feishu"]);
const ADMIN_STATUS_AVAILABLE_CHECK_ID = "admin.status_available";
const ADMIN_STATUS_AVAILABLE_LABEL = "Broker admin status endpoint is reachable for Feishu smoke evidence";
const ADMIN_STATUS_AVAILABLE_NEXT_ACTION = "Start a broker build that exposes /admin/api/status, pass the correct --base-url/--admin-token, then rerun the Feishu smoke checker.";

export interface FeishuSmokeCheck {
  readonly id: string;
  readonly label: string;
  readonly required: boolean;
  readonly status: SmokeCheckStatus;
  readonly evidence: readonly string[];
  readonly nextAction?: string | undefined;
}

export interface FeishuSmokeReport {
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly checks: readonly FeishuSmokeCheck[];
  readonly nextActions: readonly string[];
}

interface CliOptions {
  readonly baseUrl: string;
  readonly adminToken?: string | undefined;
  readonly statusFile?: string | undefined;
  readonly setupEvidenceFile?: string | undefined;
  readonly outputDir?: string | undefined;
  readonly envFile?: string | undefined;
  readonly preflight: boolean;
  readonly waitMs: number;
  readonly intervalMs: number;
  readonly json: boolean;
}

interface FeishuSmokeStatusOptions {
  readonly requireSetupEvidence?: boolean | undefined;
  readonly setupEvidence?: unknown;
}

export class AdminStatusFetchError extends Error {
  constructor(
    readonly status: number,
    readonly payloadReceived: boolean
  ) {
    super(`admin status failed (${status})`);
    this.name = "AdminStatusFetchError";
  }
}

export function evaluateFeishuSmokePreflight(
  env: Record<string, string | undefined> = process.env
): FeishuSmokeReport {
  const envDomain = normalizeKnownEnvValue(env.FEISHU_DOMAIN, ["feishu", "lark"]);
  const apiBaseUrl = env.FEISHU_API_BASE_URL?.trim() || "https://open.feishu.cn/open-apis";
  const apiBaseDomain = normalizeFeishuApiBaseUrl(apiBaseUrl);
  const groupMessageMode = normalizeKnownEnvValue(env.FEISHU_GROUP_MESSAGE_MODE, ["all", "at_only"]) ?? "all";
  const feishuEnabled = readEnvBoolean(env.FEISHU_ENABLED, false);
  const feishuStartupRequired = readEnvBoolean(env.FEISHU_STARTUP_REQUIRED, true);
  const logRawFeishuEvents = readEnvBoolean(env.LOG_RAW_FEISHU_EVENTS, false);
  const allMessageDeliveryVerified = readEnvBoolean(env.FEISHU_ALL_MESSAGE_DELIVERY_VERIFIED, false);
  const feishuBotIdentityPresent = Boolean(
    env.FEISHU_BOT_OPEN_ID || env.FEISHU_BOT_USER_ID || env.FEISHU_BOT_UNION_ID
  );
  const checks: FeishuSmokeCheck[] = [];
  const addBooleanCheck = (options: {
    readonly id: string;
    readonly label: string;
    readonly required: boolean;
    readonly passed: boolean;
    readonly evidence?: readonly string[] | undefined;
    readonly nextAction?: string | undefined;
    readonly warning?: boolean | undefined;
  }): void => {
    checks.push({
      id: options.id,
      label: options.label,
      required: options.required,
      status: options.passed ? "pass" : options.warning ? "warn" : "fail",
      evidence: options.evidence ?? [],
      nextAction: options.passed ? undefined : options.nextAction
    });
  };

  addBooleanCheck({
    id: "preflight.slack_credentials_present",
    label: "Slack credentials are present for same-process regression smoke",
    required: true,
    passed: Boolean(env.SLACK_APP_TOKEN && env.SLACK_BOT_TOKEN),
    evidence: [
      `SLACK_APP_TOKEN=${env.SLACK_APP_TOKEN ? "set" : "missing"}`,
      `SLACK_BOT_TOKEN=${env.SLACK_BOT_TOKEN ? "set" : "missing"}`
    ],
    nextAction: "Export SLACK_APP_TOKEN and SLACK_BOT_TOKEN before running dual-platform smoke."
  });
  addBooleanCheck({
    id: "preflight.feishu_enabled",
    label: "Feishu is enabled for rollout smoke",
    required: true,
    passed: feishuEnabled === true,
    evidence: [`FEISHU_ENABLED=${formatEnvBooleanEvidence(env.FEISHU_ENABLED, false)}`],
    nextAction: "Set FEISHU_ENABLED=true for the rollout runtime."
  });
  addBooleanCheck({
    id: "preflight.feishu_credentials_present",
    label: "Feishu app credentials are present",
    required: true,
    passed: Boolean(env.FEISHU_APP_ID && env.FEISHU_APP_SECRET),
    evidence: [
      `FEISHU_APP_ID=${env.FEISHU_APP_ID ? "set" : "missing"}`,
      `FEISHU_APP_SECRET=${env.FEISHU_APP_SECRET ? "set" : "missing"}`
    ],
    nextAction: "Export FEISHU_APP_ID and FEISHU_APP_SECRET for the China Feishu self-built app."
  });
  addBooleanCheck({
    id: "preflight.feishu_bot_identity_present",
    label: "Feishu bot identity is present for @bot mention detection",
    required: true,
    passed: feishuBotIdentityPresent,
    evidence: [
      `FEISHU_BOT_OPEN_ID=${env.FEISHU_BOT_OPEN_ID ? "set" : "missing"}`,
      `FEISHU_BOT_USER_ID=${env.FEISHU_BOT_USER_ID ? "set" : "missing"}`,
      `FEISHU_BOT_UNION_ID=${env.FEISHU_BOT_UNION_ID ? "set" : "missing"}`
    ],
    nextAction: "Export at least one Feishu bot identity so @bot events can start sessions."
  });
  addBooleanCheck({
    id: "scope.china_feishu",
    label: "China Feishu is the configured Feishu-family target",
    required: true,
    passed: !envDomain || envDomain === "feishu",
    evidence: [`FEISHU_DOMAIN=${formatEnvEnumEvidence(env.FEISHU_DOMAIN, "feishu", ["feishu", "lark"])}`],
    nextAction: "Set FEISHU_DOMAIN=feishu. Global Lark is outside RFC 0001."
  });
  addBooleanCheck({
    id: "preflight.feishu_api_base_china",
    label: "Feishu API base points at China Feishu Open Platform",
    required: true,
    passed: apiBaseDomain === "https://open.feishu.cn",
    evidence: [
      `FEISHU_API_BASE_URL=${formatFeishuApiBaseEvidence(apiBaseUrl)}`,
      `normalized_domain=${apiBaseDomain ?? "invalid"}`
    ],
    nextAction: "Set FEISHU_API_BASE_URL=https://open.feishu.cn/open-apis for RFC 0001."
  });
  addBooleanCheck({
    id: "preflight.group_message_mode_all",
    label: "All-group-message mode is selected for production parity smoke",
    required: true,
    passed: groupMessageMode === "all",
    evidence: [`FEISHU_GROUP_MESSAGE_MODE=${formatEnvEnumEvidence(env.FEISHU_GROUP_MESSAGE_MODE, "all", ["all", "at_only"])}`],
    nextAction: "Set FEISHU_GROUP_MESSAGE_MODE=all. at_only is a degraded pilot mode, not production parity."
  });
  addBooleanCheck({
    id: "preflight.startup_required",
    label: "Feishu startup is strict for production rollout",
    required: true,
    passed: feishuStartupRequired === true,
    evidence: [`FEISHU_STARTUP_REQUIRED=${formatEnvBooleanEvidence(env.FEISHU_STARTUP_REQUIRED, true)}`],
    nextAction: "Set FEISHU_STARTUP_REQUIRED=true before claiming production Feishu readiness."
  });
  addBooleanCheck({
    id: "preflight.raw_feishu_events_disabled",
    label: "Raw Feishu event logging is disabled",
    required: true,
    passed: logRawFeishuEvents === false,
    evidence: [`LOG_RAW_FEISHU_EVENTS=${formatEnvBooleanEvidence(env.LOG_RAW_FEISHU_EVENTS, false)}`],
    nextAction: "Set LOG_RAW_FEISHU_EVENTS=false unless collecting a focused, redacted fixture."
  });
  addBooleanCheck({
    id: "preflight.admin_token_present",
    label: "Broker admin token is present for protected evidence collection",
    required: false,
    passed: Boolean(env.BROKER_ADMIN_TOKEN),
    evidence: [`BROKER_ADMIN_TOKEN=${env.BROKER_ADMIN_TOKEN ? "set" : "missing"}`],
    warning: true,
    nextAction: "Set BROKER_ADMIN_TOKEN, or make sure the admin port is reachable only in a trusted environment."
  });
  addBooleanCheck({
    id: "preflight.all_message_delivery_flag",
    label: "All-message delivery verification flag matches saved smoke evidence",
    required: false,
    passed: allMessageDeliveryVerified !== true,
    evidence: [
      `FEISHU_ALL_MESSAGE_DELIVERY_VERIFIED=${formatEnvBooleanEvidence(env.FEISHU_ALL_MESSAGE_DELIVERY_VERIFIED, false)}`
    ],
    warning: true,
    nextAction: "Keep this true only when a saved non-@ follow-up smoke evidence bundle proves it."
  });

  const requiredFailures = checks.filter((check) => check.required && check.status !== "pass");
  return {
    ok: requiredFailures.length === 0,
    checkedAt: new Date().toISOString(),
    checks,
    nextActions: checks
      .filter((check) => check.status !== "pass" && check.nextAction)
      .map((check) => `${check.id}: ${check.nextAction}`)
  };
}

export function evaluateFeishuSmokeStatus(
  status: unknown,
  env: Record<string, string | undefined> = process.env,
  options?: FeishuSmokeStatusOptions
): FeishuSmokeReport {
  const root = asRecord(status);
  const unavailableReport = createFeishuSmokeUnavailableStatusReport(root);
  if (unavailableReport) {
    return unavailableReport;
  }

  const platforms = asRecord(root.platforms);
  const slack = asRecord(platforms.slack);
  const feishu = asRecord(platforms.feishu);
  const state = asRecord(root.state);
  const logs = asArray(state.recentBrokerLogs);
  const sessions = asArray(state.sessions);
  const feishuKnownSessions = feishuSessionMap(sessions);
  const groupAtSessionKeys = findAcceptedMessageTransitionSessionKeys(
    logs,
    "bot_mention",
    ["chat.session.created", "chat.session.resumed"],
    feishuKnownSessions,
    {
      acceptedMsgType: "text"
    }
  );
  const nonAtFollowupSessionKeys = findAcceptedMessageTransitionSessionKeys(
    logs,
    "group_message",
    ["chat.turn.steered", "chat.session.resumed"],
    feishuKnownSessions,
    {
      acceptedMsgType: "text",
      excludeStoppedTurnMessages: true,
      requireActiveTurnId: true
    }
  );
  const envDomain = normalizeKnownEnvValue(env.FEISHU_DOMAIN, ["feishu", "lark"]);
  const feishuEnabled = readBoolean(feishu.enabled);
  const groupMessageMode = readString(feishu.groupMessageMode);
  const allMessageDeliveryVerified = readBoolean(feishu.allMessageDeliveryVerified);
  const missingLogFields = findMissingFeishuLogFields(logs);
  const unsafeLogFields = findUnsafeFeishuInfoWarnLogFields(logs);
  const missingBehaviorCoverage = findMissingFeishuBehaviorCoverage(logs, sessions, feishuKnownSessions);
  const missingOutboundRichCardFile = missingRequiredFeishuOutboundRichCardFile(
    logs,
    feishuKnownSessions,
    groupAtSessionKeys
  );
  const allMessageDeliveryBackedByFollowupEvidence = hasOverlappingSessionKey(
    groupAtSessionKeys,
    nonAtFollowupSessionKeys
  );

  const checks: FeishuSmokeCheck[] = [];
  const addCheck = (check: FeishuSmokeCheck): void => {
    checks.push(check);
  };
  const addBooleanCheck = (options: {
    readonly id: string;
    readonly label: string;
    readonly required: boolean;
    readonly passed: boolean;
    readonly evidence?: readonly string[] | undefined;
    readonly nextAction?: string | undefined;
    readonly warning?: boolean | undefined;
  }): void => {
    addCheck({
      id: options.id,
      label: options.label,
      required: options.required,
      status: options.passed ? "pass" : options.warning ? "warn" : "fail",
      evidence: options.evidence ?? [],
      nextAction: options.passed ? undefined : options.nextAction
    });
  };

  addBooleanCheck({
    id: "scope.china_feishu",
    label: "China Feishu is the configured Feishu-family target",
    required: true,
    passed: !envDomain || envDomain === "feishu",
    evidence: [`FEISHU_DOMAIN=${formatEnvEnumEvidence(env.FEISHU_DOMAIN, "feishu", ["feishu", "lark"])}`],
    nextAction: "Set FEISHU_DOMAIN=feishu. Global Lark is outside RFC 0001."
  });
  addBooleanCheck({
    id: "runtime.feishu_enabled",
    label: "Feishu is enabled in the broker runtime",
    required: true,
    passed: feishuEnabled === true,
    evidence: [`platforms.feishu.enabled=${String(feishu.enabled)}`],
    nextAction: "Start the broker with FEISHU_ENABLED=true and valid Feishu app credentials."
  });
  addBooleanCheck({
    id: "runtime.feishu_ready",
    label: "Feishu reports ready in the shared runtime",
    required: true,
    passed: readString(feishu.state) === "ready",
    evidence: [`platforms.feishu.state=${readString(feishu.state) ?? "unknown"}`],
    nextAction: "Restore Feishu long-connection readiness before claiming production parity; saved ready logs alone are not enough."
  });
  addBooleanCheck({
    id: "runtime.slack_ready",
    label: "Slack still reports ready in the shared runtime",
    required: true,
    passed: readString(slack.state) === "ready",
    evidence: [`platforms.slack.state=${readString(slack.state) ?? "unknown"}`],
    nextAction: "Confirm the same broker process has valid Slack credentials and Socket Mode connectivity."
  });
  addBooleanCheck({
    id: "slack.socket_mode_ready",
    label: "Slack Socket Mode reached ready state",
    required: true,
    passed: hasSlackSocketModeReadyEvidence(slack, logs),
    evidence: [
      `platforms.slack.state=${readString(slack.state) ?? "unknown"}`,
      ...connectionEvidence(slack),
      ...platformReadyLogEvidence(logs, "slack", "socket_mode")
    ],
    nextAction: "Confirm Slack Socket Mode is connected, or save chat.platform.ready source=socket_mode / admin connection evidence."
  });
  addBooleanCheck({
    id: "slack.message_roundtrip",
    label: "Slack still receives an event and posts a reply in the shared runtime",
    required: true,
    passed: hasSlackMessageRoundtrip(logs),
    evidence: slackMessageRoundtripEvidence(logs),
    nextAction: "Send a Slack mention in the same rollout runtime and save ordered chat.message.accepted plus chat.outbound.posted Slack log lines with message IDs and the same session/thread coordinates."
  });
  addBooleanCheck({
    id: "admin.platform_health_contract",
    label: "Admin health exposes independent Slack/Feishu state, connection, and permission posture",
    required: true,
    passed: hasAdminPlatformHealthContract(slack, feishu),
    evidence: adminPlatformHealthEvidence(slack, feishu),
    nextAction: "Save /admin/api/status output with Slack socket-mode health, Feishu long-connection health, and Feishu permission posture."
  });
  addBooleanCheck({
    id: "feishu.long_connection_ready",
    label: "Feishu long connection reached ready state",
    required: true,
    passed: hasFeishuLongConnectionReadyEvidence(feishu, logs),
    evidence: [
      `platforms.feishu.state=${readString(feishu.state) ?? "unknown"}`,
      ...connectionEvidence(feishu),
      ...platformReadyLogEvidence(logs, "feishu", "long_connection")
    ],
    nextAction: "Check FEISHU_APP_ID, FEISHU_APP_SECRET, event subscription, and long connection setup."
  });
  addBooleanCheck({
    id: "feishu.all_message_verified",
    label: "All-group-message delivery is verified for production parity",
    required: true,
    passed:
      groupMessageMode === "all" &&
      allMessageDeliveryVerified === true &&
      allMessageDeliveryBackedByFollowupEvidence,
    evidence: feishuAllMessageVerificationEvidence(
      feishu,
      groupMessageMode,
      allMessageDeliveryVerified,
      allMessageDeliveryBackedByFollowupEvidence
    ),
    nextAction: "Run the non-@ follow-up smoke in all mode, save same-session group @ and non-@ transition evidence, then set FEISHU_ALL_MESSAGE_DELIVERY_VERIFIED=true."
  });
  addBooleanCheck({
    id: "feishu.group_at_created_session",
    label: "A Feishu group @bot message created or resumed a session",
    required: true,
    passed: groupAtSessionKeys.size > 0,
    evidence: [
      ...acceptedMessageTransitionEvidence(logs, "bot_mention", [
        "chat.session.created",
        "chat.session.resumed"
      ], feishuKnownSessions, {
        acceptedMsgType: "text"
      }),
      ...sessionEvidence(sessions, "feishu")
    ],
    nextAction: "In an intended Feishu group, @mention the bot with a simple Codex request, then save matching transition logs and admin session state."
  });
  addBooleanCheck({
    id: "feishu.private_ignored",
    label: "A Feishu private-chat event was ignored",
    required: true,
    passed: hasFeishuPrivateChatIgnoredWithoutSession(logs, sessions),
    evidence: [
      ...feishuPrivateChatIgnoredEvidence(logs, sessions),
      ...sessionEvidence(sessions, "feishu")
    ],
    nextAction: "Send or replay a private-chat event and verify no session is created."
  });
  addBooleanCheck({
    id: "feishu.self_sender_ignored",
    label: "A Feishu bot/app/self sender event was ignored before dispatch",
    required: true,
    passed: hasFeishuSelfSenderIgnoredBeforeDispatch(logs),
    evidence: feishuSelfSenderIgnoredEvidence(logs),
    nextAction: "Replay or capture a Feishu bot/app/self sender event and verify it emits ignored_self without same-message accepted/session/turn dispatch logs."
  });
  addBooleanCheck({
    id: "feishu.final_reply_posted",
    label: "Codex posted a text reply to Feishu",
    required: true,
    passed: hasFeishuTextReplyForKnownSession(logs, feishuKnownSessions, groupAtSessionKeys),
    evidence: [
      ...feishuTextReplyEvidence(logs, feishuKnownSessions, groupAtSessionKeys),
      ...sessionEvidence(sessions, "feishu")
    ],
    nextAction: "Let a Feishu group turn finish and confirm a reply appears in the originating group/root message with matching admin session state."
  });
  addBooleanCheck({
    id: "feishu.turn_completed",
    label: "A Feishu Codex turn emitted completion evidence",
    required: true,
    passed: hasFeishuCompletedTurnForTextReply(logs, feishuKnownSessions, groupAtSessionKeys),
    evidence: feishuCompletedTurnForTextReplyEvidence(logs, feishuKnownSessions, groupAtSessionKeys),
    nextAction: "Let a Feishu group turn finish and save the chat.turn.completed log with turn/session correlation."
  });
  addBooleanCheck({
    id: "feishu.non_at_followup",
    label: "A non-@ group follow-up reached the active session in all mode",
    required: true,
    passed:
      groupMessageMode === "all" &&
      allMessageDeliveryBackedByFollowupEvidence,
    evidence: [
      ...acceptedMessageTransitionEvidence(logs, "group_message", [
        "chat.turn.steered",
        "chat.session.resumed"
      ], feishuKnownSessions, {
        acceptedMsgType: "text",
        allowedSessionKeys: groupAtSessionKeys,
        excludeStoppedTurnMessages: true,
        requireActiveTurnId: true
      }),
      ...sessionEvidence(sessions, "feishu")
    ],
    nextAction: "While a Feishu turn is active in all mode, send a follow-up without @mentioning the bot, then save matching transition logs and admin session state."
  });
  addBooleanCheck({
    id: "feishu.stop",
    label: "`-stop` was exercised in a matching Feishu group session",
    required: true,
    passed: hasFeishuStoppedActiveTurn(logs, feishuKnownSessions, groupAtSessionKeys),
    evidence: [
      ...feishuStoppedActiveTurnEvidence(logs, feishuKnownSessions, groupAtSessionKeys),
      ...sessionEvidence(sessions, "feishu")
    ],
    nextAction: "Start a long Feishu turn, send `-stop` in the same group/root, and save the resulting log line plus admin session state."
  });
  addBooleanCheck({
    id: "feishu.history_recovered",
    label: "Bounded Feishu history recovery produced evidence",
    required: true,
    passed: hasFeishuRecoveredHistory(logs, feishuKnownSessions),
    evidence: feishuRecoveredHistoryEvidence(logs, feishuKnownSessions),
    nextAction: "Restart with an active or recently active Feishu session, then save chat.turn.steered or chat.turn.started with source=history_recovery plus chat.history.recovered recoveredCount > 0."
  });
  addBooleanCheck({
    id: "feishu.duplicate_deduped",
    label: "Duplicate Feishu delivery was deduped for an accepted message",
    required: true,
    passed: hasFeishuDedupedAcceptedMessage(logs, feishuKnownSessions),
    evidence: [
      ...logs
        .filter((log) => isDeliveredFeishuAcceptedMessageEvidence(logs, log, feishuKnownSessions))
        .slice(-3)
        .map((log) => summarizeLog(log)),
      ...feishuDedupedAcceptedMessageEvidence(logs, feishuKnownSessions)
    ],
    nextAction: "Replay a Feishu event with the same message_id and save both the original accepted log and matching chat.message.deduped log."
  });
  addBooleanCheck({
    id: "feishu.rich_card_resource",
    label: "Rich/card/resource payloads are observed without silent discard",
    required: true,
    passed: missingRequiredFeishuMessageTypes(logs, feishuKnownSessions, groupAtSessionKeys).length === 0,
    evidence: richCardResourceEvidence(logs, feishuKnownSessions, groupAtSessionKeys),
    nextAction: "Send rich text, card, image, and file messages in the same group @ session, then confirm accepted logs include msgType/payload/resource metadata, match admin session state, and are not paired with ignored logs."
  });
  addBooleanCheck({
    id: "feishu.outbound_rich_card_file",
    label: "Feishu rich/card/file outbound paths posted to the group session",
    required: true,
    passed: missingOutboundRichCardFile.length === 0,
    evidence: feishuOutboundRichCardFileEvidence(logs, feishuKnownSessions, groupAtSessionKeys),
    nextAction: "Post a Feishu rich text reply, an interactive card, and a file/image upload from the same group @ session, then save matching outbound.posted logs."
  });
  addBooleanCheck({
    id: "feishu.card_callback",
    label: "Feishu interactive card callback reached the broker",
    required: true,
    passed: hasFeishuCardCallbackForBrokerPostedGroupCard(logs, feishuKnownSessions, groupAtSessionKeys),
    evidence: [
      ...feishuCardCallbackEvidence(logs, feishuKnownSessions, groupAtSessionKeys),
      ...sessionEvidence(sessions, "feishu")
    ],
    nextAction: "Click a broker-posted Feishu card action from the same group @ session and save matching outbound card plus callback logs."
  });
  addBooleanCheck({
    id: "feishu.coauthor_card",
    label: "Feishu co-author card confirmation completed",
    required: true,
    passed: hasFeishuCoauthorConfirmedFromCardCallback(logs, feishuKnownSessions, groupAtSessionKeys),
    evidence: feishuCoauthorCardEvidence(logs, feishuKnownSessions, groupAtSessionKeys),
    nextAction: "Run a commit from a Feishu group @ session with candidates, confirm the broker-posted card, and save same-session outbound card, callback, and confirmation logs."
  });
  addBooleanCheck({
    id: "observability.required_log_fields",
    label: "Observed Feishu logs satisfy the RFC required field matrix",
    required: true,
    passed: missingLogFields.length === 0,
    evidence: missingLogFields.length === 0
      ? ["all observed Feishu RFC log events include their required fields"]
      : missingLogFields.slice(0, 8),
    nextAction: "Add the missing structured fields to the listed Feishu log event(s), then rerun the smoke checker."
  });
  addBooleanCheck({
    id: "observability.behavior_coverage",
    label: "Feishu logs prove accepted, ignored, deduped, degraded, failed, and recovered behavior",
    required: true,
    passed: missingBehaviorCoverage.length === 0,
    evidence: missingBehaviorCoverage.length === 0
      ? feishuBehaviorCoverageEvidence(logs, sessions, feishuKnownSessions)
      : [
          `missing behavior evidence: ${missingBehaviorCoverage.join(", ")}`,
          ...feishuBehaviorCoverageEvidence(logs, sessions, feishuKnownSessions)
        ],
    nextAction: "Attach a real or controlled evidence bundle that includes accepted, ignored, deduped, degraded, failed, and recovered Feishu log events."
  });
  addBooleanCheck({
    id: "observability.no_info_warn_body_leaks",
    label: "Feishu info/warn logs do not expose raw body or secret fields",
    required: true,
    passed: unsafeLogFields.length === 0,
    evidence: unsafeLogFields.length === 0
      ? ["no forbidden raw body/secret field names found in Feishu info/warn log metadata"]
      : unsafeLogFields.slice(0, 8),
    nextAction: "Move raw payload/body data to sanitized fixtures or explicit raw debug streams before retrying."
  });
  if (options?.requireSetupEvidence) {
    addCheck(evaluateFeishuSetupEvidence(options.setupEvidence));
  }

  const requiredFailures = checks.filter((check) => check.required && check.status !== "pass");
  return {
    ok: requiredFailures.length === 0,
    checkedAt: new Date().toISOString(),
    checks,
    nextActions: checks
      .filter((check) => check.status !== "pass" && check.nextAction)
      .map((check) => `${check.id}: ${check.nextAction}`)
  };
}

export function evaluateFeishuSetupEvidence(setupEvidence: unknown): FeishuSmokeCheck {
  const root = asRecord(setupEvidence);
  const labels = asRecord(root.consoleLabels);
  const permissions = asRecord(root.permissions);
  const groupPermission = asRecord(permissions.imMessageGroupMsg);
  const target = readString(root.target)?.trim().toLowerCase();
  const requiredLabels = [
    "appType",
    "botCapability",
    "eventDelivery",
    "receiveMessageEvent",
    "groupMessagePermission",
    "sendMessagePermission",
    "cardCallback",
    "resourcePermission",
    "botIdentitySource"
  ];
  const missingLabels = requiredLabels.filter((key) => !readString(labels[key]));
  const groupPermissionApiName = readString(groupPermission.apiName)?.trim();
  const groupPermissionStatus = readString(groupPermission.status)?.trim().toLowerCase();
  const groupPermissionApprovalEvidence = readString(groupPermission.approvalEvidence)?.trim();
  const missingPermissionPosture = findMissingSetupPermissionPosture(permissions);
  const targetOk = target === "china_feishu" || target === "feishu";
  const unsafeSetupEvidencePaths = findUnsafeSetupEvidencePaths(root);
  const placeholderSetupEvidencePaths = findPlaceholderSetupEvidencePaths(root);
  const passed = targetOk &&
    missingLabels.length === 0 &&
    groupPermissionApiName === "im:message.group_msg" &&
    groupPermissionStatus === "approved" &&
    Boolean(groupPermissionApprovalEvidence) &&
    missingPermissionPosture.length === 0 &&
    unsafeSetupEvidencePaths.length === 0 &&
    placeholderSetupEvidencePaths.length === 0;

  return {
    id: "setup.console_labels_recorded",
    label: "Real tenant setup evidence records Feishu console labels and group-message approval",
    required: true,
    status: passed ? "pass" : "fail",
    evidence: [
      `target=${target ?? "missing"}`,
      `consoleLabels=${requiredLabels.length - missingLabels.length}/${requiredLabels.length}`,
      `im:message.group_msg.apiName=${groupPermissionApiName ?? "missing"}`,
      `im:message.group_msg=${groupPermissionStatus ?? "missing"}`,
      `approvalEvidence=${groupPermissionApprovalEvidence ? "set" : "missing"}`,
      ...setupPermissionPostureEvidence(permissions),
      unsafeSetupEvidencePaths.length === 0
        ? "setup evidence contains no raw secrets, tokens, user emails, or raw bot IDs"
        : `unsafe setup evidence: ${unsafeSetupEvidencePaths.slice(0, 8).join(", ")}`,
      ...(placeholderSetupEvidencePaths.length > 0
        ? [`placeholder setup evidence: ${placeholderSetupEvidencePaths.slice(0, 8).join(", ")}`]
        : []),
      ...(missingPermissionPosture.length > 0 ? [`missing permission posture: ${missingPermissionPosture.join(", ")}`] : []),
      ...(missingLabels.length > 0 ? [`missing labels: ${missingLabels.join(", ")}`] : [])
    ],
    nextAction: passed
      ? undefined
      : unsafeSetupEvidencePaths.length > 0
        ? "Remove raw App Secret/access token/message body/user email/raw bot ID values from setup evidence; keep only set/missing posture, console labels, and redacted ticket references."
        : "Fill setup evidence with exact real-tenant console labels, im:message.group_msg approval status, and send/card/resource permission posture; do not leave example or placeholder text."
  };
}

function findMissingSetupPermissionPosture(permissions: Record<string, unknown>): string[] {
  const missing: string[] = [];
  for (const requirement of SETUP_PERMISSION_POSTURE_REQUIREMENTS) {
    const permission = asRecord(permissions[requirement.key]);
    const apiValue = readString(permission[requirement.apiField])?.trim();
    const status = readString(permission.status)?.trim().toLowerCase();
    const evidence = readString(permission[requirement.evidenceField])?.trim();
    const allowedApiNames = requirement.allowedApiNames as readonly string[] | undefined;
    const allowedStatuses = requirement.allowedStatuses as readonly string[];

    if (!apiValue) {
      missing.push(`${requirement.label}.${requirement.apiField}`);
    } else if (allowedApiNames && !allowedApiNames.includes(apiValue)) {
      missing.push(`${requirement.label}.${requirement.apiField}=${allowedApiNames.join("|")}`);
    }
    if (!status || !allowedStatuses.includes(status)) {
      missing.push(`${requirement.label}.status=${allowedStatuses.join("|")}`);
    }
    if (!evidence) {
      missing.push(`${requirement.label}.${requirement.evidenceField}`);
    }
  }

  return missing;
}

function setupPermissionPostureEvidence(permissions: Record<string, unknown>): string[] {
  return SETUP_PERMISSION_POSTURE_REQUIREMENTS.flatMap((requirement) => {
    const permission = asRecord(permissions[requirement.key]);
    const apiValue = readString(permission[requirement.apiField])?.trim();
    const status = readString(permission.status)?.trim().toLowerCase();
    const evidence = readString(permission[requirement.evidenceField])?.trim();
    return [
      `${requirement.label}.${requirement.apiField}=${apiValue ?? "missing"}`,
      `${requirement.label}=${status ?? "missing"}`,
      `${requirement.label}.${requirement.evidenceField}=${evidence ? "set" : "missing"}`
    ];
  });
}

export async function evaluateFeishuSmokeStatusFile(
  statusFile: string,
  env: Record<string, string | undefined> = process.env,
  options?: {
    readonly setupEvidence?: unknown;
    readonly setupEvidenceFile?: string | undefined;
  }
): Promise<FeishuSmokeReport> {
  const status = JSON.parse(await fs.readFile(statusFile, "utf8")) as unknown;
  const setupEvidence = options?.setupEvidence ?? (
    options?.setupEvidenceFile ? await readJsonFile(options.setupEvidenceFile) : undefined
  );
  return evaluateFeishuSmokeStatus(status, env, {
    requireSetupEvidence: true,
    setupEvidence
  });
}

export function createFeishuSmokeUnavailableReport(options: {
  readonly baseUrl: string;
  readonly error: unknown;
  readonly checkedAt?: string | undefined;
}): FeishuSmokeReport {
  const check: FeishuSmokeCheck = {
    id: ADMIN_STATUS_AVAILABLE_CHECK_ID,
    label: ADMIN_STATUS_AVAILABLE_LABEL,
    required: true,
    status: "fail",
    evidence: [
      `base_url=${formatSafeBaseUrlEvidence(options.baseUrl)}`,
      ...adminFetchFailureEvidence(options.error)
    ],
    nextAction: ADMIN_STATUS_AVAILABLE_NEXT_ACTION
  };

  return {
    ok: false,
    checkedAt: options.checkedAt ?? new Date().toISOString(),
    checks: [check],
    nextActions: [`${check.id}: ${check.nextAction}`]
  };
}

export async function writeFeishuSmokeEvidenceBundle(options: {
  readonly outputDir: string;
  readonly source: string;
  readonly status: unknown;
  readonly report: FeishuSmokeReport;
  readonly setupEvidence?: unknown;
}): Promise<{
  readonly statusFile: string;
  readonly setupEvidenceFile?: string | undefined;
  readonly reportFile: string;
  readonly summaryFile: string;
}> {
  await fs.mkdir(options.outputDir, {
    recursive: true
  });
  const statusFile = path.join(options.outputDir, "admin-status.json");
  const reportFile = path.join(options.outputDir, "feishu-smoke-report.json");
  const summaryFile = path.join(options.outputDir, "feishu-smoke-summary.md");
  const setupEvidenceFile = options.setupEvidence
    ? path.join(options.outputDir, "feishu-setup-evidence.json")
    : undefined;
  const report = sanitizeFeishuSmokeReport(options.report);
  const statusEvidence = options.status === undefined
    ? createFeishuSmokeUnavailableStatusEvidence(report)
    : sanitizeFeishuSmokeStatusEvidence(options.status);

  await fs.writeFile(statusFile, `${JSON.stringify(statusEvidence, null, 2)}\n`);
  if (setupEvidenceFile) {
    await fs.writeFile(
      setupEvidenceFile,
      `${JSON.stringify(sanitizeFeishuSmokeSetupEvidence(options.setupEvidence), null, 2)}\n`
    );
  }
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(summaryFile, renderMarkdownSummary(options.source, report));

  return {
    statusFile,
    setupEvidenceFile,
    reportFile,
    summaryFile
  };
}

function createFeishuSmokeUnavailableStatusEvidence(report: FeishuSmokeReport): Record<string, unknown> {
  const statusCheck = report.checks.find((check) => check.id === ADMIN_STATUS_AVAILABLE_CHECK_ID) ?? report.checks[0];

  return withoutUndefinedRecord({
    adminStatus: withoutUndefinedRecord({
      available: false,
      checkedAt: report.checkedAt,
      checkId: statusCheck?.id,
      evidence: statusCheck?.evidence,
      nextAction: statusCheck?.nextAction
    }),
    platforms: sanitizeFeishuSmokePlatformsEvidence(undefined),
    state: withoutUndefinedRecord({
      platform: "feishu",
      sessionCount: 0,
      activeCount: 0,
      sessions: [],
      recentBrokerLogs: []
    })
  });
}

function createFeishuSmokeUnavailableStatusReport(root: Record<string, unknown>): FeishuSmokeReport | undefined {
  const adminStatus = asRecord(root.adminStatus);
  if (readBoolean(adminStatus.available) !== false) {
    return undefined;
  }

  const evidence = asArray(adminStatus.evidence)
    .map(readString)
    .filter((value): value is string => Boolean(value))
    .map(sanitizeFeishuSmokeReportEvidenceText);
  const nextAction = readString(adminStatus.nextAction)
    ? sanitizeFeishuSmokeReportEvidenceText(readString(adminStatus.nextAction)!)
    : ADMIN_STATUS_AVAILABLE_NEXT_ACTION;
  const check: FeishuSmokeCheck = {
    id: ADMIN_STATUS_AVAILABLE_CHECK_ID,
    label: ADMIN_STATUS_AVAILABLE_LABEL,
    required: true,
    status: "fail",
    evidence: evidence.length > 0 ? evidence : ["adminStatus.available=false"],
    nextAction
  };

  return {
    ok: false,
    checkedAt: readSafeFeishuSmokeLogTimestamp(adminStatus.checkedAt) ?? new Date().toISOString(),
    checks: [check],
    nextActions: [`${check.id}: ${nextAction}`]
  };
}

export async function writeFeishuPreflightEvidenceBundle(options: {
  readonly outputDir: string;
  readonly report: FeishuSmokeReport;
}): Promise<{
  readonly reportFile: string;
  readonly summaryFile: string;
}> {
  await fs.mkdir(options.outputDir, {
    recursive: true
  });
  const report = sanitizeFeishuSmokeReport(options.report);
  const reportFile = path.join(options.outputDir, "feishu-preflight-report.json");
  const summaryFile = path.join(options.outputDir, "feishu-preflight-summary.md");

  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(summaryFile, renderMarkdownSummary("environment-preflight", report));

  return {
    reportFile,
    summaryFile
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const initialOptions = parseArgs(argv, process.env);
  const env = await loadFeishuSmokeEnv(process.env, initialOptions.envFile);
  const options = initialOptions.envFile ? parseArgs(argv, env) : initialOptions;
  if (options.preflight) {
    const report = evaluateFeishuSmokePreflight(env);
    if (options.outputDir) {
      const bundle = await writeFeishuPreflightEvidenceBundle({
        outputDir: options.outputDir,
        report
      });
      if (!options.json) {
        console.log(renderFeishuSmokeBundleNotice("preflight", bundle.summaryFile));
      }
    }
    if (options.json) {
      console.log(JSON.stringify(sanitizeFeishuSmokeReport(report), null, 2));
    } else {
      printHumanReport(sanitizeFeishuSmokeReport(report), {
        ...options,
        baseUrl: "environment-preflight"
      });
    }
    if (!report.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (options.statusFile) {
    const status = await readJsonFile(options.statusFile);
    const setupEvidence = options.setupEvidenceFile
      ? await readJsonFile(options.setupEvidenceFile)
      : undefined;
    const report = evaluateFeishuSmokeStatus(status, env, {
      requireSetupEvidence: true,
      setupEvidence
    });
    if (options.outputDir) {
      const bundle = await writeFeishuSmokeEvidenceBundle({
        outputDir: options.outputDir,
        source: `status-file:${options.statusFile}`,
        status,
        report,
        setupEvidence
      });
      if (!options.json) {
        console.log(renderFeishuSmokeBundleNotice("evidence", bundle.summaryFile));
      }
    }
    if (options.json) {
      console.log(JSON.stringify(sanitizeFeishuSmokeReport(report), null, 2));
    } else {
      printHumanReport(sanitizeFeishuSmokeReport(report), {
        ...options,
        baseUrl: `status-file:${options.statusFile}`
      });
    }
    if (!report.ok) {
      process.exitCode = 1;
    }
    return;
  }

  const deadline = Date.now() + options.waitMs;
  let report: FeishuSmokeReport | undefined;
  let status: unknown;
  let lastError: unknown;

  do {
    try {
      status = await fetchAdminStatus(options);
      const setupEvidence = options.setupEvidenceFile
        ? await readJsonFile(options.setupEvidenceFile)
        : undefined;
      report = evaluateFeishuSmokeStatus(status, env, {
        requireSetupEvidence: true,
        setupEvidence
      });
      if (report.ok || Date.now() >= deadline) {
        break;
      }
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) {
        break;
      }
    }
    await delay(options.intervalMs);
  } while (Date.now() < deadline);

  if (!report) {
    report = createFeishuSmokeUnavailableReport({
      baseUrl: options.baseUrl,
      error: lastError
    });
  }

  if (options.outputDir) {
    const setupEvidence = options.setupEvidenceFile
      ? await readJsonFile(options.setupEvidenceFile)
      : undefined;
    const bundle = await writeFeishuSmokeEvidenceBundle({
      outputDir: options.outputDir,
      source: options.baseUrl,
      status,
      report,
      setupEvidence
    });
    if (!options.json) {
      console.log(renderFeishuSmokeBundleNotice("evidence", bundle.summaryFile));
    }
  }

  if (options.json) {
    console.log(JSON.stringify(sanitizeFeishuSmokeReport(report), null, 2));
  } else {
    printHumanReport(sanitizeFeishuSmokeReport(report), options);
  }

  if (!report.ok) {
    process.exitCode = 1;
  }
}

async function fetchAdminStatus(options: CliOptions): Promise<unknown> {
  const init: RequestInit = options.adminToken
    ? {
        headers: {
          "x-admin-token": options.adminToken
        }
      }
    : {};
  const response = await fetch(`${options.baseUrl.replace(/\/+$/u, "")}/admin/api/status?platform=feishu`, init);
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    throw new AdminStatusFetchError(response.status, payload !== null);
  }
  return payload;
}

function adminFetchFailureEvidence(error: unknown): string[] {
  if (error instanceof AdminStatusFetchError) {
    return [
      `http_status=${error.status}`,
      `response_payload=${error.payloadReceived ? "present" : "empty"}`
    ];
  }

  if (error instanceof Error) {
    return [`error_class=${error.name || "Error"}`];
  }

  return ["error_class=unknown"];
}

function formatSafeBaseUrlEvidence(value: string): string {
  try {
    const url = new URL(value);
    const pathname = url.pathname.replace(/\/+$/u, "");
    return `${url.origin}${pathname}`;
  } catch {
    return "invalid_url";
  }
}

function parseArgs(argv: readonly string[], env: Record<string, string | undefined>): CliOptions {
  let baseUrl = env.BROKER_API_BASE ?? env.BROKER_HTTP_BASE_URL ?? "http://127.0.0.1:3000";
  let adminToken = env.BROKER_ADMIN_TOKEN;
  let statusFile: string | undefined;
  let setupEvidenceFile = env.FEISHU_SETUP_EVIDENCE_FILE;
  let outputDir: string | undefined;
  let envFile: string | undefined;
  let preflight = false;
  let waitMs = 0;
  let intervalMs = 2_000;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = argv[index + 1];
    const option = splitCliOption(arg);
    const optionName = option?.name ?? arg;
    const readValue = (name: string): string => {
      if (option?.value !== undefined) {
        if (!option.value) {
          throw new Error(`Missing value for ${name}`);
        }
        return option.value;
      }
      if (!next || next === "--" || next.startsWith("--")) {
        throw new Error(`Missing value for ${name}`);
      }
      index += 1;
      return next;
    };

    if (arg === "--") {
      continue;
    } else if (optionName === "--base-url") {
      baseUrl = readValue("--base-url");
    } else if (optionName === "--admin-token") {
      adminToken = readValue("--admin-token");
    } else if (optionName === "--status-file") {
      statusFile = readValue("--status-file");
    } else if (optionName === "--setup-evidence-file") {
      setupEvidenceFile = readValue("--setup-evidence-file");
    } else if (optionName === "--output-dir") {
      outputDir = readValue("--output-dir");
    } else if (optionName === "--env-file") {
      envFile = readValue("--env-file");
    } else if (optionName === "--preflight") {
      rejectInlineCliValue(option, "--preflight");
      preflight = true;
    } else if (optionName === "--wait-ms") {
      waitMs = readNonNegativeInteger(readValue("--wait-ms"), "--wait-ms");
    } else if (optionName === "--interval-ms") {
      intervalMs = readNonNegativeInteger(readValue("--interval-ms"), "--interval-ms");
    } else if (optionName === "--json") {
      rejectInlineCliValue(option, "--json");
      json = true;
    } else if (optionName === "--help" || optionName === "-h") {
      rejectInlineCliValue(option, optionName);
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    baseUrl,
    adminToken,
    statusFile,
    setupEvidenceFile,
    outputDir,
    envFile,
    preflight,
    waitMs,
    intervalMs,
    json
  };
}

function splitCliOption(arg: string): { readonly name: string; readonly value?: string | undefined } | undefined {
  if (!arg.startsWith("--")) {
    return undefined;
  }
  const equalsIndex = arg.indexOf("=");
  if (equalsIndex < 0) {
    return { name: arg };
  }
  return {
    name: arg.slice(0, equalsIndex),
    value: arg.slice(equalsIndex + 1)
  };
}

function rejectInlineCliValue(
  option: { readonly value?: string | undefined } | undefined,
  name: string
): void {
  if (option?.value !== undefined) {
    throw new Error(`Unexpected value for ${name}`);
  }
}

function readNonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

export function renderFeishuSmokeHumanReport(
  report: FeishuSmokeReport,
  options: Pick<CliOptions, "baseUrl">
): string {
  const sanitizedReport = sanitizeFeishuSmokeReport(report);
  const lines = [
    `Feishu smoke evidence for ${sanitizeFeishuSmokeReportSource(options.baseUrl)}`,
    `checked_at: ${sanitizedReport.checkedAt}`,
    `status: ${sanitizedReport.ok ? "PASS" : "MISSING_EVIDENCE"}`
  ];

  for (const check of sanitizedReport.checks) {
    const prefix = check.status === "pass" ? "[PASS]" : check.status === "warn" ? "[WARN]" : "[FAIL]";
    lines.push(`${prefix} ${check.id} - ${check.label}`);
    for (const evidence of check.evidence.slice(0, 3)) {
      lines.push(`  evidence: ${evidence}`);
    }
    if (check.status !== "pass" && check.nextAction) {
      lines.push(`  next: ${check.nextAction}`);
    }
  }

  return lines.join("\n");
}

function printHumanReport(report: FeishuSmokeReport, options: CliOptions): void {
  console.log(renderFeishuSmokeHumanReport(report, options));
}

export function formatFeishuSmokeCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeFeishuSmokeReportEvidenceText(sanitizeFeishuSmokeCliErrorPaths(message));
}

function sanitizeFeishuSmokeCliErrorPaths(message: string): string {
  return message
    .replace(/(["'])(\/[^"']+)\1/gu, (_match, quote: string, filePath: string) =>
      `${quote}${sanitizeFeishuSmokeOutputFileName(filePath)}${quote}`
    )
    .replace(/(^|[\s=])\/(?!\/)([^\s'"]+)/gu, (_match, prefix: string, pathTail: string) =>
      `${prefix}${sanitizeFeishuSmokeOutputFileName(`/${pathTail}`)}`
    );
}

export function renderFeishuSmokeBundleNotice(kind: "evidence" | "preflight", summaryFile: string): string {
  return `wrote ${kind} bundle: ${sanitizeFeishuSmokeOutputFileName(summaryFile)}`;
}

function sanitizeFeishuSmokeOutputFileName(filePath: string): string {
  const fileName = path.basename(filePath) || "summary.md";
  return sanitizeFeishuSmokeReportEvidenceText(fileName);
}

function printUsage(): void {
  console.log([
    "usage: pnpm manual:feishu-smoke -- --setup-evidence-file setup.json [--base-url http://127.0.0.1:3000] [--admin-token token] [--wait-ms 60000] [--output-dir evidence/feishu] [--json]",
    "       pnpm manual:feishu-smoke -- --status-file admin-status.json --setup-evidence-file setup.json [--env-file .env] [--output-dir evidence/feishu] [--json]",
    "       pnpm manual:feishu-smoke -- --preflight [--env-file .env] [--output-dir evidence/feishu] [--json]",
    "",
    "Checks /admin/api/status and recent broker logs for RFC 0001 real Feishu smoke evidence.",
    "The script does not send Feishu messages itself; perform the smoke actions in Feishu, then run this checker.",
    "Use --preflight before rollout to check required env vars, production mode, and raw logging posture.",
    "Use --env-file to load explicit KEY=value settings from a local env file; through pnpm, pass a leading -- before smoke-checker args so Node does not consume --env-file.",
    "Value flags require a following value that is not another --flag.",
    "Value flags accept both --flag value and --flag=value forms.",
    "Use --status-file to verify saved evidence from a rollout PR or incident bundle.",
    "Final smoke and --status-file verification require --setup-evidence-file to prove real Feishu console labels and im:message.group_msg approval were recorded.",
    "Use --output-dir to save admin-status.json, feishu-setup-evidence.json, feishu-smoke-report.json, and feishu-smoke-summary.md.",
    "With --preflight, --output-dir saves feishu-preflight-report.json and feishu-preflight-summary.md."
  ].join("\n"));
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
}

export async function loadFeishuSmokeEnv(
  baseEnv: Record<string, string | undefined>,
  envFile?: string | undefined
): Promise<Record<string, string | undefined>> {
  if (!envFile) {
    return baseEnv;
  }

  const fileEnv = parseFeishuSmokeEnvFile(await fs.readFile(envFile, "utf8"));
  const merged: Record<string, string | undefined> = {
    ...fileEnv
  };
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

export function parseFeishuSmokeEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  const lines = content.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(trimmed);
    if (!match) {
      throw new Error(`Invalid env file line ${index + 1}: expected KEY=value`);
    }

    env[match[1]!] = parseFeishuSmokeEnvValue(match[2] ?? "");
  }
  return env;
}

function parseFeishuSmokeEnvValue(rawValue: string): string {
  const value = rawValue.trim();
  const quote = value[0];
  if ((quote === "\"" || quote === "'") && value.endsWith(quote)) {
    const inner = value.slice(1, -1);
    if (quote === "\"") {
      return inner
        .replace(/\\n/gu, "\n")
        .replace(/\\r/gu, "\r")
        .replace(/\\t/gu, "\t")
        .replace(/\\"/gu, "\"")
        .replace(/\\\\/gu, "\\");
    }
    return inner.replace(/\\'/gu, "'");
  }

  return value.replace(/\s+#.*$/u, "").trim();
}

function renderMarkdownSummary(source: string, report: FeishuSmokeReport): string {
  const lines = [
    "# Feishu Smoke Evidence",
    "",
    `- source: ${sanitizeFeishuSmokeReportSource(source)}`,
    `- checked_at: ${report.checkedAt}`,
    `- status: ${report.ok ? "PASS" : "MISSING_EVIDENCE"}`,
    "",
    "## Checks",
    "",
    "| Status | Required | Check | Evidence |",
    "| --- | --- | --- | --- |"
  ];

  for (const check of report.checks) {
    lines.push([
      check.status,
      check.required ? "yes" : "no",
      `${check.id}: ${check.label}`,
      check.evidence.length > 0 ? check.evidence.join("<br>") : check.nextAction ?? ""
    ].map(escapeMarkdownTableCell).join(" | ").replace(/^/u, "| ").replace(/$/u, " |"));
  }

  if (report.nextActions.length > 0) {
    lines.push("", "## Next Actions", "");
    for (const action of report.nextActions) {
      lines.push(`- ${action}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function sanitizeFeishuSmokeReportSource(source: string): string {
  if (source.startsWith("status-file:")) {
    const fileName = path.basename(source.slice("status-file:".length)) || "status.json";
    return `status-file:${sanitizeFeishuSmokeReportEvidenceText(fileName)}`;
  }

  if (source === "environment-preflight") {
    return source;
  }

  return sanitizeFeishuSmokeReportEvidenceText(formatSafeBaseUrlEvidence(source));
}

function sanitizeFeishuSmokeReport(report: FeishuSmokeReport): FeishuSmokeReport {
  return {
    ok: report.ok,
    checkedAt: readSafeFeishuSmokeLogTimestamp(report.checkedAt) ?? "[redacted unsafe evidence]",
    checks: report.checks.map((check) => ({
      id: sanitizeFeishuSmokeReportEvidenceText(check.id),
      label: sanitizeFeishuSmokeReportEvidenceText(check.label),
      required: check.required,
      status: check.status,
      evidence: check.evidence.map(sanitizeFeishuSmokeReportEvidenceText),
      nextAction: check.nextAction
        ? sanitizeFeishuSmokeReportEvidenceText(check.nextAction)
        : undefined
    })),
    nextActions: report.nextActions.map(sanitizeFeishuSmokeReportEvidenceText)
  };
}

function sanitizeFeishuSmokeReportEvidenceText(value: string): string {
  const protectedLiterals = new Map<string, string>();
  const protectedValue = SAFE_SMOKE_REPORT_EVIDENCE_LITERALS.reduce((text, literal, index) => {
    const placeholder = `__feishu_safe_evidence_literal_${index}__`;
    protectedLiterals.set(placeholder, literal);
    return text.replaceAll(literal, placeholder);
  }, value);

  const sanitized = protectedValue
    .replace(SECRET_LIKE_SMOKE_REPORT_EVIDENCE_VALUE, "[redacted unsafe evidence]")
    .replace(SENTINEL_LIKE_SMOKE_REPORT_EVIDENCE_VALUE, "[redacted unsafe evidence]");

  return [...protectedLiterals.entries()].reduce(
    (text, [placeholder, literal]) => text.replaceAll(placeholder, literal),
    sanitized
  );
}

function sanitizeFeishuSmokeStatusEvidence(status: unknown): Record<string, unknown> {
  const root = asRecord(status);
  const state = asRecord(root.state);
  const sessions = asArray(state.sessions)
    .filter(isFeishuSmokeSessionEvidence)
    .map(sanitizeFeishuSmokeSessionEvidence);
  return withoutUndefinedRecord({
    platforms: sanitizeFeishuSmokePlatformsEvidence(root.platforms),
    state: withoutUndefinedRecord({
      platform: "feishu",
      sessionCount: sessions.length,
      activeCount: sessions.filter((session) => readString(session.activeTurnId)).length,
      sessions,
      recentBrokerLogs: asArray(state.recentBrokerLogs).map(sanitizeFeishuSmokeBrokerLogEvidence)
    })
  });
}

function sanitizeFeishuSmokePlatformsEvidence(platforms: unknown): Record<string, unknown> {
  const record = asRecord(platforms);
  return withoutUndefinedRecord({
    slack: sanitizeFeishuSmokePlatformEvidence("slack", asRecord(record.slack)),
    feishu: sanitizeFeishuSmokePlatformEvidence("feishu", asRecord(record.feishu))
  });
}

function sanitizeFeishuSmokePlatformEvidence(
  platform: "slack" | "feishu",
  status: Record<string, unknown>
): Record<string, unknown> {
  const connection = sanitizeFeishuSmokeConnectionEvidence(asRecord(status.connection));
  const permissions = asArray(status.permissions)
    .map(sanitizeFeishuSmokePermissionEvidence)
    .filter((permission) => Object.keys(permission).length > 0);

  return withoutUndefinedRecord({
    platform,
    enabled: readBoolean(status.enabled),
    state: readKnownString(status.state, SMOKE_PLATFORM_HEALTH_STATES),
    startupRequired: readBoolean(status.startupRequired),
    groupMessageMode: readKnownString(status.groupMessageMode, SMOKE_FEISHU_GROUP_MESSAGE_MODES),
    allMessageDeliveryVerified: readBoolean(status.allMessageDeliveryVerified),
    degradedReason: readSafeFeishuSmokeLogToken(status.degradedReason),
    connection: Object.keys(connection).length > 0 ? connection : undefined,
    permissions: permissions.length > 0 ? permissions : undefined
  });
}

function sanitizeFeishuSmokeConnectionEvidence(connection: Record<string, unknown>): Record<string, unknown> {
  return withoutUndefinedRecord({
    mode: readKnownString(connection.mode, SMOKE_PLATFORM_CONNECTION_MODES),
    connected: readBoolean(connection.connected),
    lastConnectedAt: readSafeFeishuSmokeLogTimestamp(connection.lastConnectedAt),
    lastDisconnectedAt: readSafeFeishuSmokeLogTimestamp(connection.lastDisconnectedAt)
  });
}

function sanitizeFeishuSmokePermissionEvidence(permission: unknown): Record<string, unknown> {
  const record = asRecord(permission);
  return withoutUndefinedRecord({
    name: readSafeFeishuSmokeLogToken(record.name),
    status: readKnownString(record.status, SMOKE_PERMISSION_STATUSES)
  });
}

function sanitizeFeishuSmokeSetupEvidence(value: unknown): unknown {
  if (typeof value === "string") {
    return SECRET_LIKE_SETUP_EVIDENCE_VALUE.test(value)
      ? "[redacted unsafe setup evidence]"
      : value;
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map(sanitizeFeishuSmokeSetupEvidence)
      .filter((entry) => entry !== undefined);
  }

  const record = asRecord(value);
  const safeEntries = Object.entries(record)
    .filter(([key]) => !FORBIDDEN_SETUP_EVIDENCE_KEYS.has(normalizeEvidenceKey(key)))
    .map(([key, nested]) => [key, sanitizeFeishuSmokeSetupEvidence(nested)] as const)
    .filter(([, nested]) => nested !== undefined);

  return safeEntries.length > 0 ? Object.fromEntries(safeEntries) : undefined;
}

function sanitizeFeishuSmokeBrokerLogEvidence(log: unknown): Record<string, unknown> {
  const record = asRecord(log);
  const meta = sanitizeFeishuSmokeLogMetaEvidence(asRecord(record.meta));

  return withoutUndefinedRecord({
    ts: readSafeFeishuSmokeLogTimestamp(record.ts),
    type: readSafeFeishuSmokeLogToken(record.type),
    level: readSafeFeishuSmokeLogToken(record.level),
    message: readSafeFeishuSmokeLogToken(record.message),
    meta
  });
}

function sanitizeFeishuSmokeLogMetaEvidence(meta: Record<string, unknown>): Record<string, unknown> | undefined {
  const safeEntries = Object.entries(meta).filter(([key, value]) =>
    FEISHU_SMOKE_SAFE_LOG_META_FIELDS.has(key) && isSafeFeishuSmokeLogMetaValue(value)
  );

  return safeEntries.length > 0 ? Object.fromEntries(safeEntries) : undefined;
}

function isSafeFeishuSmokeLogMetaValue(value: unknown): boolean {
  if (typeof value === "string") {
    return !SECRET_LIKE_INFO_WARN_META_VALUE.test(value);
  }

  return typeof value === "number" || typeof value === "boolean" || value === null;
}

function readSafeFeishuSmokeLogToken(value: unknown): string | undefined {
  const text = readString(value);
  return text && SAFE_FEISHU_SMOKE_LOG_TOKEN.test(text) ? text : undefined;
}

function readSafeFeishuSmokeLogTimestamp(value: unknown): string | undefined {
  const text = readString(value);
  return text && SAFE_FEISHU_SMOKE_LOG_TIMESTAMP.test(text) ? text : undefined;
}

function readKnownString(value: unknown, allowedValues: ReadonlySet<string>): string | undefined {
  const text = readString(value);
  return text && allowedValues.has(text) ? text : undefined;
}

function sanitizeFeishuSmokeSessionEvidence(session: unknown): Record<string, unknown> {
  const record = asRecord(session);
  return withoutUndefinedRecord({
    key: readSafeFeishuSmokeSessionToken(record.key),
    sessionKey: readSafeFeishuSmokeSessionToken(record.sessionKey),
    platform: readKnownString(record.platform, SMOKE_SESSION_PLATFORMS),
    conversationId: readSafeFeishuSmokeSessionToken(record.conversationId),
    conversationKind: readSafeFeishuSmokeSessionToken(record.conversationKind),
    rootMessageId: readSafeFeishuSmokeSessionToken(record.rootMessageId),
    platformThreadId: readSafeFeishuSmokeSessionToken(record.platformThreadId),
    activeTurnId: readSafeFeishuSmokeSessionToken(record.activeTurnId),
    lastObservedMessageTs: readSafeFeishuSmokeLogTimestamp(record.lastObservedMessageTs),
    lastDeliveredMessageTs: readSafeFeishuSmokeLogTimestamp(record.lastDeliveredMessageTs)
  });
}

function isFeishuSmokeSessionEvidence(session: unknown): boolean {
  return readString(asRecord(session).platform) === "feishu";
}

function readSafeFeishuSmokeSessionToken(value: unknown): string | undefined {
  const text = readString(value);
  if (!text || !SAFE_FEISHU_SMOKE_SESSION_TOKEN.test(text) || SECRET_LIKE_INFO_WARN_META_VALUE.test(text)) {
    return undefined;
  }

  return text;
}

function withoutUndefinedRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined)
  );
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\n/gu, "<br>");
}

function hasFeishuSession(sessions: readonly unknown[]): boolean {
  return sessions.some((session) => readString(asRecord(session).platform) === "feishu");
}

function missingRequiredFeishuMessageTypes(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys: ReadonlySet<string>
): string[] {
  const observed = new Set(feishuDeliveredMessageTypes(logs, knownSessions, allowedSessionKeys));
  return ["rich_text", "card", "image", "file"].filter((type) => !observed.has(type));
}

function richCardResourceEvidence(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys: ReadonlySet<string>
): string[] {
  const missingTypes = missingRequiredFeishuMessageTypes(logs, knownSessions, allowedSessionKeys);
  const observed = messageTypeEvidence(logs, ["rich_text", "card", "image", "file"], knownSessions, allowedSessionKeys);
  return [
    `requiredSession=group_at groupAtSessionCount=${allowedSessionKeys.size}`,
    ...(missingTypes.length > 0 ? [`missing msgType: ${missingTypes.join(", ")}`] : []),
    ...observed
  ];
}

function feishuAllMessageVerificationEvidence(
  feishu: Record<string, unknown>,
  groupMessageMode: string | undefined,
  allMessageDeliveryVerified: boolean | undefined,
  allMessageDeliveryBackedByFollowupEvidence: boolean
): string[] {
  const permissionStatus = readPermissionStatusMap(feishu).get("im:message.group_msg");
  return [
    `groupMessageMode=${groupMessageMode ?? "unknown"}`,
    `allMessageDeliveryVerified=${String(allMessageDeliveryVerified)}`,
    `sameSessionNonAtFollowup=${String(allMessageDeliveryBackedByFollowupEvidence)}`,
    `permission.im:message.group_msg=${permissionStatus ?? "missing"}`
  ];
}

const FEISHU_OUTBOUND_RICH_CARD_FILE_REQUIREMENTS: readonly {
  readonly label: string;
  readonly formats: readonly string[];
}[] = [
  {
    label: "rich_text",
    formats: ["markdown", "rich_text"]
  },
  {
    label: "card",
    formats: ["card"]
  },
  {
    label: "file",
    formats: ["file", "image"]
  }
] as const;

function missingRequiredFeishuOutboundRichCardFile(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys: ReadonlySet<string>
): string[] {
  const observed = new Set(feishuOutboundRichCardFileLabels(logs, knownSessions, allowedSessionKeys));
  return FEISHU_OUTBOUND_RICH_CARD_FILE_REQUIREMENTS
    .filter((requirement) => !observed.has(requirement.label))
    .map((requirement) => requirement.label);
}

function feishuOutboundRichCardFileEvidence(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys: ReadonlySet<string>
): string[] {
  const missing = missingRequiredFeishuOutboundRichCardFile(logs, knownSessions, allowedSessionKeys);
  const observed = logs
    .filter((log) => isFeishuOutboundRichCardFileEvidence(log, knownSessions, allowedSessionKeys))
    .slice(-6)
    .map((log) => summarizeLog(log));

  return [
    `requiredSession=group_at groupAtSessionCount=${allowedSessionKeys.size}`,
    ...(missing.length > 0 ? [`missing outbound format: ${missing.join(", ")}`] : []),
    ...observed
  ];
}

function feishuOutboundRichCardFileLabels(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys: ReadonlySet<string>
): string[] {
  return logs.flatMap((log) => {
    if (!isFeishuOutboundRichCardFileEvidence(log, knownSessions, allowedSessionKeys)) {
      return [];
    }

    const format = readString(asRecord(asRecord(log).meta).format);
    const requirement = FEISHU_OUTBOUND_RICH_CARD_FILE_REQUIREMENTS.find((candidate) =>
      candidate.formats.includes(format ?? "")
    );
    return requirement ? [requirement.label] : [];
  });
}

function isFeishuOutboundRichCardFileEvidence(
  log: unknown,
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys: ReadonlySet<string>
): boolean {
  if (allowedSessionKeys.size === 0) {
    return false;
  }

  const record = asRecord(log);
  const meta = asRecord(record.meta);
  const format = readString(meta.format);
  if (
    readString(record.message) !== "chat.outbound.posted" ||
    readString(meta.platform) !== "feishu" ||
    !format ||
    !FEISHU_OUTBOUND_RICH_CARD_FILE_REQUIREMENTS.some((requirement) => requirement.formats.includes(format)) ||
    (requiresOutboundResourceIdentifier(meta) && !hasPresentField(meta, "fileId"))
  ) {
    return false;
  }

  const knownSession = findMatchingKnownSessionWithRequiredCoordinates(knownSessions, meta);
  return Boolean(knownSession && allowedSessionKeys.has(knownSession.key));
}

function findMissingFeishuBehaviorCoverage(
  logs: readonly unknown[],
  sessions: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>
): string[] {
  const coverage = {
    accepted: hasDeliveredFeishuAcceptedMessage(logs, knownSessions),
    ignored: hasFeishuPrivateChatIgnoredWithoutSession(logs, sessions),
    deduped: hasFeishuDedupedAcceptedMessage(logs, knownSessions),
    degraded: hasFeishuDegradedBehavior(logs),
    failed: hasFeishuFailedBehavior(logs, knownSessions),
    recovered: hasFeishuRecoveredHistory(logs, knownSessions)
  };

  return Object.entries(coverage)
    .filter(([, covered]) => !covered)
    .map(([name]) => name);
}

function hasFeishuFailedBehavior(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>
): boolean {
  return logs.some((log) => isFeishuFailedBehaviorEvidence(log, knownSessions));
}

function isFeishuFailedBehaviorEvidence(
  log: unknown,
  knownSessions: ReadonlyMap<string, FeishuKnownSession>
): boolean {
  const record = asRecord(log);
  const meta = asRecord(record.meta);
  const message = readString(record.message);
  if (readString(meta.platform) !== "feishu") {
    return false;
  }

  if (message === "chat.handler.failed") {
    return FEISHU_HANDLER_NAMES.has(readString(meta.handler) ?? "") &&
      hasPresentField(meta, "errorClass");
  }

  if (message === "chat.outbound.failed") {
    return Boolean(findMatchingKnownSession(knownSessions, meta)) &&
      hasPresentField(meta, "format") &&
      hasPresentField(meta, "errorClass") &&
      hasPresentField(meta, "statusCode") &&
      hasPresentField(meta, "attempt");
  }

  if (message === "chat.attachment.download_failed") {
    return Boolean(findMatchingKnownSession(knownSessions, meta)) &&
      hasPresentField(meta, "messageId") &&
      hasPresentField(meta, "attachmentId") &&
      hasPresentField(meta, "kind") &&
      hasPresentField(meta, "errorClass");
  }

  return false;
}

function feishuFailedBehaviorEvidenceLabel(log: unknown): string {
  const message = readString(asRecord(log).message);
  if (message === "chat.handler.failed") {
    return "handler_failed";
  }

  if (message === "chat.attachment.download_failed") {
    return "attachment_download_failed";
  }

  return "outbound_failed";
}

function feishuBehaviorCoverageEvidence(
  logs: readonly unknown[],
  sessions: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>
): string[] {
  const acceptedEvidence = logs
    .filter((log) => isDeliveredFeishuAcceptedMessageEvidence(logs, log, knownSessions))
    .slice(-1)
    .map((log) => `accepted: ${summarizeLog(log)}`);
  const ignoredEvidence = feishuPrivateChatIgnoredEvidence(logs, sessions)
    .slice(-1)
    .map((evidence) => `ignored: ${evidence}`);
  const degradedEvidence = logs
    .filter((log) => isFeishuDegradedBehaviorEvidence(log))
    .slice(-1)
    .map((log) => `degraded: ${summarizeLog(log)}`);
  const dedupedEvidence = feishuDedupedAcceptedMessageEvidence(logs, knownSessions)
    .slice(-1)
    .map((evidence) => `deduped: ${evidence}`);
  const failedEvidence = logs
    .filter((log) => isFeishuFailedBehaviorEvidence(log, knownSessions))
    .slice(-3)
    .map((log) => `${feishuFailedBehaviorEvidenceLabel(log)}: ${summarizeLog(log)}`);
  const recoveryEvidence = feishuRecoveredHistoryEvidence(logs, knownSessions)
    .slice(-3)
    .map((evidence) => `recovered: ${evidence}`);

  return [...acceptedEvidence, ...ignoredEvidence, ...degradedEvidence, ...dedupedEvidence, ...failedEvidence, ...recoveryEvidence]
    .slice(0, 8);
}

function hasFeishuDegradedBehavior(logs: readonly unknown[]): boolean {
  return logs.some((log) => isFeishuDegradedBehaviorEvidence(log));
}

function isFeishuDegradedBehaviorEvidence(log: unknown): boolean {
  const record = asRecord(log);
  const meta = asRecord(record.meta);
  if (
    readString(record.message) !== "chat.platform.degraded" ||
    readString(meta.platform) !== "feishu"
  ) {
    return false;
  }

  const degradedReason = readString(meta.degradedReason);
  if (!degradedReason || !FEISHU_PLATFORM_DEGRADED_REASONS.has(degradedReason)) {
    return false;
  }

  return !isPermissionRelatedDegradation(meta) || hasPresentField(meta, "permission");
}

function hasDeliveredFeishuAcceptedMessage(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>
): boolean {
  return logs.some((log) => isDeliveredFeishuAcceptedMessageEvidence(logs, log, knownSessions));
}

function feishuDeliveredMessageTypes(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys: ReadonlySet<string>
): string[] {
  return logs
    .filter((log) => isDeliveredFeishuMessageTypeEvidence(logs, log, knownSessions, allowedSessionKeys))
    .map((log) => readString(asRecord(asRecord(log).meta).msgType))
    .filter((type): type is string => Boolean(type));
}

function messageTypeEvidence(
  logs: readonly unknown[],
  types: readonly string[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys: ReadonlySet<string>
): string[] {
  return logs
    .filter((log) =>
      types.includes(readString(asRecord(asRecord(log).meta).msgType) ?? "") &&
      isDeliveredFeishuMessageTypeEvidence(logs, log, knownSessions, allowedSessionKeys)
    )
    .slice(-4)
    .map((log) => summarizeLog(log));
}

function isDeliveredFeishuMessageTypeEvidence(
  logs: readonly unknown[],
  log: unknown,
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys: ReadonlySet<string>
): boolean {
  const record = asRecord(log);
  const meta = asRecord(record.meta);
  return isDeliveredFeishuAcceptedMessageEvidence(logs, log, knownSessions) &&
    acceptedMessageMatchesAllowedFeishuSession(logs, meta, knownSessions, allowedSessionKeys);
}

function isDeliveredFeishuAcceptedMessageEvidence(
  logs: readonly unknown[],
  log: unknown,
  knownSessions: ReadonlyMap<string, FeishuKnownSession>
): boolean {
  const record = asRecord(log);
  const meta = asRecord(record.meta);
  return readString(record.message) === "chat.message.accepted" &&
    readString(meta.platform) === "feishu" &&
    acceptedMessageMatchesKnownFeishuSession(logs, meta, knownSessions) &&
    !hasMatchingFeishuIgnoredMessage(logs, meta);
}

function acceptedMessageMatchesKnownFeishuSession(
  logs: readonly unknown[],
  accepted: Record<string, unknown>,
  knownSessions: ReadonlyMap<string, FeishuKnownSession>
): boolean {
  if (coordinatesMatchKnownFeishuSession(knownSessions, accepted)) {
    return true;
  }

  const acceptedRoute = readString(accepted.route) ?? "";
  const acceptedMessageId = readString(accepted.messageId);
  if (!acceptedMessageId) {
    return false;
  }

  return logs.some((log) => {
    const record = asRecord(log);
    const message = readString(record.message);
    const meta = asRecord(record.meta);
    if (
      readString(meta.platform) !== "feishu" ||
      readString(meta.messageId) !== acceptedMessageId ||
      (message !== "chat.session.resumed" && message !== "chat.turn.steered")
    ) {
      return false;
    }

    const knownSession = findMatchingKnownSession(knownSessions, meta);
    if (!knownSession) {
      return false;
    }

    return acceptedMessageCanTransitionToKnownSession(acceptedRoute, accepted, knownSession);
  });
}

function acceptedMessageMatchesAllowedFeishuSession(
  logs: readonly unknown[],
  accepted: Record<string, unknown>,
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys: ReadonlySet<string>
): boolean {
  if (allowedSessionKeys.size === 0) {
    return false;
  }

  const directSession = findMatchingKnownSessionWithRequiredCoordinates(knownSessions, accepted) ??
    findKnownSessionByRequiredCoordinates(knownSessions, accepted);
  if (directSession && allowedSessionKeys.has(directSession.key)) {
    return true;
  }

  const acceptedRoute = readString(accepted.route) ?? "";
  const acceptedMessageId = readString(accepted.messageId);
  if (!acceptedMessageId) {
    return false;
  }

  return logs.some((log) => {
    const record = asRecord(log);
    const message = readString(record.message);
    const meta = asRecord(record.meta);
    if (
      readString(meta.platform) !== "feishu" ||
      readString(meta.messageId) !== acceptedMessageId ||
      (message !== "chat.session.resumed" && message !== "chat.turn.steered")
    ) {
      return false;
    }

    const knownSession = findMatchingKnownSession(knownSessions, meta);
    return Boolean(
      knownSession &&
      allowedSessionKeys.has(knownSession.key) &&
      acceptedMessageCanTransitionToKnownSession(acceptedRoute, accepted, knownSession)
    );
  });
}

function findKnownSessionByRequiredCoordinates(
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  meta: Record<string, unknown>
): FeishuKnownSession | undefined {
  const conversationId = readString(meta.conversationId);
  const rootMessageId = readString(meta.rootMessageId);
  if (!conversationId || !rootMessageId) {
    return undefined;
  }

  return [...knownSessions.values()].find((session) =>
    session.conversationId === conversationId &&
    session.rootMessageId === rootMessageId
  );
}

function hasMatchingFeishuIgnoredMessage(logs: readonly unknown[], accepted: Record<string, unknown>): boolean {
  const acceptedConversationId = readString(accepted.conversationId);
  const acceptedMessageId = readString(accepted.messageId);
  if (!acceptedConversationId || !acceptedMessageId) {
    return true;
  }

  return logs.some((log) => {
    const record = asRecord(log);
    const meta = asRecord(record.meta);
    return readString(record.message) === "chat.message.ignored" &&
      readString(meta.platform) === "feishu" &&
      readString(meta.conversationId) === acceptedConversationId &&
      readString(meta.messageId) === acceptedMessageId;
  });
}

function findMissingFeishuLogFields(logs: readonly unknown[]): string[] {
  const missing: string[] = [];

  for (const log of logs) {
    const record = asRecord(log);
    const message = readString(record.message);
    const meta = asRecord(record.meta);
    if (readString(meta.platform) !== "feishu" || !message) {
      continue;
    }

    const requiredFields = REQUIRED_FEISHU_LOG_FIELDS[message];
    if (!requiredFields) {
      continue;
    }

    const missingFields = requiredFields.filter((field) => !hasPresentField(meta, field));
    if (
      message === "chat.outbound.posted" &&
      !hasPresentField(meta, "messageId") &&
      !hasPresentField(meta, "fileId")
    ) {
      missingFields.push("messageId or fileId");
    }
    if (
      message === "chat.outbound.posted" &&
      requiresOutboundResourceIdentifier(meta) &&
      !hasPresentField(meta, "fileId")
    ) {
      missingFields.push("fileId when format=file|image");
    }
    if (
      message === "chat.platform.degraded" &&
      isPermissionRelatedDegradation(meta) &&
      !hasPresentField(meta, "permission")
    ) {
      missingFields.push("permission");
    }
    if (
      message === "chat.history.recovered" &&
      readString(record.level) === "warn" &&
      !hasPresentField(meta, "degradedReason")
    ) {
      missingFields.push("degradedReason");
    }
    if (
      message === "chat.session.resumed" &&
      isActiveFeishuSessionResumedLog(logs, meta) &&
      !hasActiveTurnId(meta)
    ) {
      missingFields.push("turnId when active");
    }
    if (
      message === "chat.turn.stopped" &&
      readBoolean(meta.hadActiveTurn) === true &&
      !hasActiveTurnId(meta)
    ) {
      missingFields.push("active turnId");
    }
    if (
      message === "chat.handler.failed" &&
      !FEISHU_HANDLER_NAMES.has(readString(meta.handler) ?? "")
    ) {
      missingFields.push("handler=message|interactive");
    }
    if (message === "chat.card.callback.received" && hasPresentField(meta, "kind") && !hasKnownCoauthorActionKind(meta)) {
      missingFields.push("kind=coauthor_confirm_all|coauthor_skip");
    }
    if (
      message === "chat.card.callback.received" &&
      hasKnownCoauthorActionKind(meta) &&
      !hasPositiveNumber(meta, "candidateRevision")
    ) {
      missingFields.push("candidateRevision when co-author action");
    }
    if (
      message === "chat.card.callback.received" &&
      hasPresentField(meta, "candidateRevision") &&
      !hasKnownCoauthorActionKind(meta)
    ) {
      missingFields.push("kind when co-author action");
    }
    if (
      message === "chat.message.accepted" &&
      requiresRetainedPayloadRef(meta) &&
      !hasPresentField(meta, "payloadRef")
    ) {
      missingFields.push("payloadRef");
    }
    if (
      message === "chat.message.accepted" &&
      requiresResourceIdentifier(meta) &&
      !hasPresentField(meta, "fileId")
    ) {
      missingFields.push("fileId");
    }
    const expectedPayloadRef = expectedPayloadRefForLog(message, meta);
    if (
      expectedPayloadRef &&
      hasPresentField(meta, "payloadRef") &&
      readString(meta.payloadRef) !== expectedPayloadRef
    ) {
      missingFields.push(`payloadRef=${expectedPayloadRef}`);
    }
    if (missingFields.length > 0) {
      missing.push(`${message}: missing ${missingFields.join(", ")}`);
    }
  }

  return missing;
}

function isActiveFeishuSessionResumedLog(
  logs: readonly unknown[],
  resumedMeta: Record<string, unknown>
): boolean {
  const messageId = readString(resumedMeta.messageId);
  const sessionKey = readString(resumedMeta.sessionKey);
  if (!messageId) {
    return false;
  }

  return logs.some((log) => {
    const record = asRecord(log);
    const message = readString(record.message);
    const meta = asRecord(record.meta);
    if (
      readString(meta.platform) !== "feishu" ||
      readString(meta.messageId) !== messageId ||
      (sessionKey && readString(meta.sessionKey) !== sessionKey)
    ) {
      return false;
    }

    if (message === "chat.turn.steered") {
      return hasActiveTurnId(meta);
    }

    return message === "chat.turn.stopped" && readBoolean(meta.hadActiveTurn) === true;
  });
}

function isPermissionRelatedDegradation(meta: Record<string, unknown>): boolean {
  const degradedReason = readString(meta.degradedReason);
  return degradedReason === "all_message_delivery_unverified" ||
    degradedReason === "group_message_all_unavailable";
}

function hasKnownCoauthorActionKind(meta: Record<string, unknown>): boolean {
  const kind = readString(meta.kind);
  return kind === "coauthor_confirm_all" || kind === "coauthor_skip";
}

function hasPositiveNumber(meta: Record<string, unknown>, field: string): boolean {
  return (readNumber(meta[field]) ?? 0) > 0;
}

function requiresRetainedPayloadRef(meta: Record<string, unknown>): boolean {
  const msgType = readString(meta.msgType);
  return msgType === "rich_text" ||
    msgType === "card" ||
    msgType === "image" ||
    msgType === "file";
}

function requiresResourceIdentifier(meta: Record<string, unknown>): boolean {
  const msgType = readString(meta.msgType);
  return msgType === "image" || msgType === "file";
}

function requiresOutboundResourceIdentifier(meta: Record<string, unknown>): boolean {
  const format = readString(meta.format);
  return format === "image" || format === "file";
}

function expectedPayloadRefForLog(message: string, meta: Record<string, unknown>): string | undefined {
  if (message === "chat.message.accepted" && requiresRetainedPayloadRef(meta)) {
    const messageId = readString(meta.messageId);
    return messageId ? `feishu-message:${messageId}` : undefined;
  }

  if (message === "chat.card.callback.received") {
    const eventId = readString(meta.eventId);
    return eventId ? `feishu-card:${eventId}` : undefined;
  }

  return undefined;
}

function findUnsafeFeishuInfoWarnLogFields(logs: readonly unknown[]): string[] {
  const unsafe: string[] = [];

  for (const log of logs) {
    const record = asRecord(log);
    const level = readString(record.level);
    const message = readString(record.message) ?? "unknown";
    const meta = asRecord(record.meta);
    if (readString(meta.platform) !== "feishu" || (level !== "info" && level !== "warn")) {
      continue;
    }

    for (const issue of findForbiddenMetaIssues(meta)) {
      unsafe.push(`${message}: forbidden meta ${issue}`);
    }
  }

  return unsafe;
}

function findForbiddenMetaIssues(value: unknown, prefix = "meta"): string[] {
  if (typeof value === "string") {
    return SECRET_LIKE_INFO_WARN_META_VALUE.test(value) ? [`value ${prefix}`] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((nested, index) => findForbiddenMetaIssues(nested, `${prefix}[${index}]`));
  }

  const record = asRecord(value);
  const matches: string[] = [];

  for (const [key, nested] of Object.entries(record)) {
    const normalizedKey = key.toLowerCase();
    const fieldPath = `${prefix}.${key}`;
    if (FORBIDDEN_INFO_WARN_META_KEYS.has(normalizedKey)) {
      matches.push(`field ${fieldPath}`);
      continue;
    }

    if (typeof nested === "string" && SECRET_LIKE_INFO_WARN_META_VALUE.test(nested)) {
      matches.push(`value ${fieldPath}`);
      continue;
    }

    if (nested && typeof nested === "object") {
      matches.push(...findForbiddenMetaIssues(nested, fieldPath));
    }
  }

  return matches;
}

function findUnsafeSetupEvidencePaths(value: unknown, prefix = "setupEvidence"): string[] {
  if (typeof value === "string") {
    return SECRET_LIKE_SETUP_EVIDENCE_VALUE.test(value) ? [prefix] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((nested, index) => findUnsafeSetupEvidencePaths(nested, `${prefix}[${index}]`));
  }

  const record = asRecord(value);
  const matches: string[] = [];

  for (const [key, nested] of Object.entries(record)) {
    const fieldPath = `${prefix}.${key}`;
    if (FORBIDDEN_SETUP_EVIDENCE_KEYS.has(normalizeEvidenceKey(key))) {
      matches.push(fieldPath);
      continue;
    }

    if (typeof nested === "string" && SECRET_LIKE_SETUP_EVIDENCE_VALUE.test(nested)) {
      matches.push(fieldPath);
      continue;
    }

    if (nested && typeof nested === "object") {
      matches.push(...findUnsafeSetupEvidencePaths(nested, fieldPath));
    }
  }

  return matches;
}

function findPlaceholderSetupEvidencePaths(value: unknown, prefix = "setupEvidence"): string[] {
  if (typeof value === "string") {
    return PLACEHOLDER_LIKE_SETUP_EVIDENCE_VALUE.test(value) ? [prefix] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((nested, index) => findPlaceholderSetupEvidencePaths(nested, `${prefix}[${index}]`));
  }

  const record = asRecord(value);
  const matches: string[] = [];

  for (const [key, nested] of Object.entries(record)) {
    const fieldPath = `${prefix}.${key}`;
    if (typeof nested === "string" && PLACEHOLDER_LIKE_SETUP_EVIDENCE_VALUE.test(nested)) {
      matches.push(fieldPath);
      continue;
    }

    if (nested && typeof nested === "object") {
      matches.push(...findPlaceholderSetupEvidencePaths(nested, fieldPath));
    }
  }

  return matches;
}

function normalizeEvidenceKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function hasPresentField(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  return value !== undefined && value !== null;
}

function hasLog(logs: readonly unknown[], message: string, meta: Record<string, string>): boolean {
  return logs.some((log) => logMatches(log, message, meta));
}

function hasAcceptedMessageTransition(
  logs: readonly unknown[],
  acceptedRoute: string,
  transitionMessages: readonly string[],
  options?: {
    readonly knownSessions?: ReadonlyMap<string, FeishuKnownSession> | undefined;
    readonly excludeStoppedTurnMessages?: boolean | undefined;
    readonly requireActiveTurnId?: boolean | undefined;
  }
): boolean {
  if (options?.knownSessions) {
    return findAcceptedMessageTransitionSessionKeys(
      logs,
      acceptedRoute,
      transitionMessages,
      options.knownSessions,
      {
        excludeStoppedTurnMessages: options.excludeStoppedTurnMessages,
        requireActiveTurnId: options.requireActiveTurnId
      }
    ).size > 0;
  }

  const acceptedMessages = logs
    .map((log, index) => ({
      index,
      meta: asRecord(asRecord(log).meta),
      matchesRoute: logMatches(log, "chat.message.accepted", {
        platform: "feishu",
        route: acceptedRoute
      })
    }))
    .filter(({ matchesRoute, meta }) =>
      matchesRoute &&
      Boolean(readString(meta.messageId)) &&
      !hasMatchingFeishuIgnoredMessage(logs, meta) &&
      !(options?.excludeStoppedTurnMessages && hasMatchingFeishuStoppedTurnMessage(logs, meta))
    );
  if (acceptedMessages.length === 0) {
    return false;
  }

  return logs.some((log, transitionIndex) => {
    const record = asRecord(log);
    const message = readString(record.message);
    const meta = asRecord(record.meta);
    if (!message) {
      return false;
    }

    if (!transitionMessages.includes(message) || readString(meta.platform) !== "feishu") {
      return false;
    }

    const knownSession = options?.knownSessions
      ? findMatchingKnownSession(options.knownSessions, meta)
      : undefined;
    if (options?.knownSessions && !knownSession) {
      return false;
    }
    if (
      options?.requireActiveTurnId &&
      (message === "chat.session.resumed" || message === "chat.turn.steered") &&
      !hasActiveTurnId(meta)
    ) {
      return false;
    }

    return acceptedMessages.some((accepted) =>
      accepted.index < transitionIndex &&
      readString(accepted.meta.messageId) === readString(meta.messageId) &&
      (!knownSession || sessionMatchesLogCoordinates(knownSession, accepted.meta))
    );
  });
}

function findAcceptedMessageTransitionSessionKeys(
  logs: readonly unknown[],
  acceptedRoute: string,
  transitionMessages: readonly string[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  options?: {
    readonly acceptedMsgType?: string | undefined;
    readonly excludeStoppedTurnMessages?: boolean | undefined;
    readonly requireActiveTurnId?: boolean | undefined;
  }
): Set<string> {
  const acceptedMessages = logs
    .map((log, index) => ({
      index,
      meta: asRecord(asRecord(log).meta),
      matchesRoute: logMatches(log, "chat.message.accepted", {
        platform: "feishu",
        route: acceptedRoute
      })
    }))
    .filter(({ matchesRoute, meta }) =>
      matchesRoute &&
      Boolean(readString(meta.messageId)) &&
      (!options?.acceptedMsgType || readString(meta.msgType) === options.acceptedMsgType) &&
      !hasMatchingFeishuIgnoredMessage(logs, meta) &&
      !(options?.excludeStoppedTurnMessages && hasMatchingFeishuStoppedTurnMessage(logs, meta))
    );
  const transitionSessionKeys = new Set<string>();
  if (acceptedMessages.length === 0) {
    return transitionSessionKeys;
  }

  for (const [transitionIndex, log] of logs.entries()) {
    const record = asRecord(log);
    const message = readString(record.message);
    const meta = asRecord(record.meta);
    if (!message || !transitionMessages.includes(message) || readString(meta.platform) !== "feishu") {
      continue;
    }

    const knownSession = findMatchingKnownSession(knownSessions, meta);
    if (!knownSession) {
      continue;
    }

    if (
      options?.requireActiveTurnId &&
      (message === "chat.session.resumed" || message === "chat.turn.steered") &&
      !hasActiveTurnId(meta)
    ) {
      continue;
    }

    const transitionMessageId = readString(meta.messageId);
    if (
      acceptedMessages.some((accepted) =>
        accepted.index < transitionIndex &&
        readString(accepted.meta.messageId) === transitionMessageId &&
        acceptedMessageCanTransitionToKnownSession(acceptedRoute, accepted.meta, knownSession)
      )
    ) {
      transitionSessionKeys.add(knownSession.key);
    }
  }

  return transitionSessionKeys;
}

function acceptedMessageTransitionEvidence(
  logs: readonly unknown[],
  acceptedRoute: string,
  transitionMessages: readonly string[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  options?: {
    readonly acceptedMsgType?: string | undefined;
    readonly allowedSessionKeys?: ReadonlySet<string> | undefined;
    readonly excludeStoppedTurnMessages?: boolean | undefined;
    readonly requireActiveTurnId?: boolean | undefined;
  }
): string[] {
  return findAcceptedMessageTransitionEvidenceLogs(logs, acceptedRoute, transitionMessages, knownSessions, options)
    .slice(-6)
    .map((log) => summarizeLog(log));
}

function findAcceptedMessageTransitionEvidenceLogs(
  logs: readonly unknown[],
  acceptedRoute: string,
  transitionMessages: readonly string[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  options?: {
    readonly acceptedMsgType?: string | undefined;
    readonly allowedSessionKeys?: ReadonlySet<string> | undefined;
    readonly excludeStoppedTurnMessages?: boolean | undefined;
    readonly requireActiveTurnId?: boolean | undefined;
  }
): unknown[] {
  if (options?.allowedSessionKeys && options.allowedSessionKeys.size === 0) {
    return [];
  }

  const acceptedMessages = logs
    .map((log, index) => ({
      index,
      log,
      meta: asRecord(asRecord(log).meta),
      matchesRoute: logMatches(log, "chat.message.accepted", {
        platform: "feishu",
        route: acceptedRoute
      })
    }))
    .filter(({ matchesRoute, meta }) =>
      matchesRoute &&
      Boolean(readString(meta.messageId)) &&
      (!options?.acceptedMsgType || readString(meta.msgType) === options.acceptedMsgType) &&
      !hasMatchingFeishuIgnoredMessage(logs, meta) &&
      !(options?.excludeStoppedTurnMessages && hasMatchingFeishuStoppedTurnMessage(logs, meta))
    );
  if (acceptedMessages.length === 0) {
    return [];
  }

  const evidenceLogs = new Set<unknown>();
  for (const [transitionIndex, log] of logs.entries()) {
    const record = asRecord(log);
    const message = readString(record.message);
    const meta = asRecord(record.meta);
    if (!message || !transitionMessages.includes(message) || readString(meta.platform) !== "feishu") {
      continue;
    }

    const knownSession = findMatchingKnownSession(knownSessions, meta);
    if (!knownSession || (options?.allowedSessionKeys && !options.allowedSessionKeys.has(knownSession.key))) {
      continue;
    }

    if (
      options?.requireActiveTurnId &&
      (message === "chat.session.resumed" || message === "chat.turn.steered") &&
      !hasActiveTurnId(meta)
    ) {
      continue;
    }

    const transitionMessageId = readString(meta.messageId);
    const matchingAcceptedMessages = acceptedMessages.filter(({ index: acceptedIndex, meta: accepted }) =>
      acceptedIndex < transitionIndex &&
      readString(accepted.messageId) === transitionMessageId &&
      acceptedMessageCanTransitionToKnownSession(acceptedRoute, accepted, knownSession)
    );
    if (matchingAcceptedMessages.length === 0) {
      continue;
    }

    for (const accepted of matchingAcceptedMessages) {
      evidenceLogs.add(accepted.log);
    }
    evidenceLogs.add(log);
  }

  return logs.filter((log) => evidenceLogs.has(log));
}

function acceptedMessageCanTransitionToKnownSession(
  acceptedRoute: string,
  accepted: Record<string, unknown>,
  knownSession: FeishuKnownSession
): boolean {
  if (sessionMatchesLogCoordinates(knownSession, accepted)) {
    return true;
  }

  const acceptedConversationId = readString(accepted.conversationId);
  const acceptedRootMessageId = readString(accepted.rootMessageId);
  const acceptedMessageId = readString(accepted.messageId);
  return acceptedRoute === "group_message" &&
    acceptedConversationId === knownSession.conversationId &&
    Boolean(acceptedRootMessageId) &&
    acceptedRootMessageId === acceptedMessageId;
}

function hasActiveTurnId(meta: Record<string, unknown>): boolean {
  const turnId = readString(meta.turnId);
  return Boolean(turnId && turnId !== "none");
}

function hasMatchingFeishuStoppedTurnMessage(
  logs: readonly unknown[],
  sourceMeta: Record<string, unknown>
): boolean {
  const sourceConversationId = readString(sourceMeta.conversationId);
  const sourceRootMessageId = readString(sourceMeta.rootMessageId);
  const sourceMessageId = readString(sourceMeta.messageId);
  if (!sourceConversationId || !sourceMessageId) {
    return false;
  }

  return logs.some((log) => {
    const record = asRecord(log);
    const meta = asRecord(record.meta);
    return readString(record.message) === "chat.turn.stopped" &&
      readString(meta.platform) === "feishu" &&
      readString(meta.conversationId) === sourceConversationId &&
      (!sourceRootMessageId || readString(meta.rootMessageId) === sourceRootMessageId) &&
      readString(meta.messageId) === sourceMessageId;
  });
}

function hasFeishuPrivateChatIgnoredWithoutSession(logs: readonly unknown[], sessions: readonly unknown[]): boolean {
  const ignoredConversationIds = logs
    .filter((log) => logMatches(log, "chat.message.ignored", {
      platform: "feishu",
      conversationKind: "direct",
      ignoredReason: "ignored_private_chat"
    }))
    .map((log) => readString(asRecord(asRecord(log).meta).conversationId))
    .filter((conversationId): conversationId is string => Boolean(conversationId));
  if (ignoredConversationIds.length === 0) {
    return false;
  }

  const feishuSessionConversationIds = new Set(
    sessions
      .map((session) => asRecord(session))
      .filter((session) => readString(session.platform) === "feishu")
      .map((session) => readString(session.conversationId))
      .filter((conversationId): conversationId is string => Boolean(conversationId))
  );

  return ignoredConversationIds.every((conversationId) => !feishuSessionConversationIds.has(conversationId));
}

function feishuPrivateChatIgnoredEvidence(logs: readonly unknown[], sessions: readonly unknown[]): string[] {
  if (!hasFeishuPrivateChatIgnoredWithoutSession(logs, sessions)) {
    return [];
  }

  return findFeishuPrivateChatIgnoredWithoutSessionLogs(logs, sessions)
    .slice(-3)
    .map((log) => summarizeLog(log));
}

function findFeishuPrivateChatIgnoredWithoutSessionLogs(logs: readonly unknown[], sessions: readonly unknown[]): unknown[] {
  const feishuSessionConversationIds = new Set(
    sessions
      .map((session) => asRecord(session))
      .filter((session) => readString(session.platform) === "feishu")
      .map((session) => readString(session.conversationId))
      .filter((conversationId): conversationId is string => Boolean(conversationId))
  );

  return logs.filter((log) => {
    const record = asRecord(log);
    const meta = asRecord(record.meta);
    const conversationId = readString(meta.conversationId);
    if (!conversationId) {
      return false;
    }

    return readString(record.message) === "chat.message.ignored" &&
      readString(meta.platform) === "feishu" &&
      readString(meta.conversationKind) === "direct" &&
      readString(meta.ignoredReason) === "ignored_private_chat" &&
      !feishuSessionConversationIds.has(conversationId);
  });
}

function hasFeishuSelfSenderIgnoredBeforeDispatch(logs: readonly unknown[]): boolean {
  return findFeishuSelfSenderIgnoredBeforeDispatchLogs(logs).length > 0;
}

function feishuSelfSenderIgnoredEvidence(logs: readonly unknown[]): string[] {
  return findFeishuSelfSenderIgnoredBeforeDispatchLogs(logs)
    .slice(-3)
    .map((log) => summarizeLog(log));
}

function findFeishuSelfSenderIgnoredBeforeDispatchLogs(logs: readonly unknown[]): unknown[] {
  return logs.filter((log) => {
    const record = asRecord(log);
    const meta = asRecord(record.meta);
    if (
      readString(record.message) !== "chat.message.ignored" ||
      readString(meta.platform) !== "feishu" ||
      readString(meta.ignoredReason) !== "ignored_self" ||
      readString(meta.conversationKind) !== "group" ||
      !["app", "bot", "user"].includes(readString(meta.senderKind) ?? "") ||
      !readString(meta.conversationId) ||
      !readString(meta.messageId)
    ) {
      return false;
    }

    return !hasMatchingFeishuAcceptedOrDispatchMessage(logs, meta);
  });
}

function hasMatchingFeishuAcceptedOrDispatchMessage(
  logs: readonly unknown[],
  ignoredMeta: Record<string, unknown>
): boolean {
  const ignoredConversationId = readString(ignoredMeta.conversationId);
  const ignoredMessageId = readString(ignoredMeta.messageId);
  if (!ignoredConversationId || !ignoredMessageId) {
    return true;
  }

  return logs.some((candidate) => {
    const candidateRecord = asRecord(candidate);
    const candidateMessage = readString(candidateRecord.message);
    const candidateMeta = asRecord(candidateRecord.meta);
    if (
      readString(candidateMeta.platform) !== "feishu" ||
      readString(candidateMeta.conversationId) !== ignoredConversationId
    ) {
      return false;
    }

    if (candidateMessage === "chat.message.accepted") {
      return readString(candidateMeta.messageId) === ignoredMessageId;
    }

    if (
      candidateMessage === "chat.session.created" ||
      candidateMessage === "chat.session.resumed" ||
      candidateMessage === "chat.turn.started" ||
      candidateMessage === "chat.turn.steered" ||
      candidateMessage === "chat.turn.stopped"
    ) {
      return readString(candidateMeta.messageId) === ignoredMessageId ||
        readString(candidateMeta.batchId) === ignoredMessageId;
    }

    return false;
  });
}

interface FeishuKnownSession {
  readonly key: string;
  readonly conversationId?: string | undefined;
  readonly rootMessageId?: string | undefined;
}

function feishuSessionMap(sessions: readonly unknown[]): ReadonlyMap<string, FeishuKnownSession> {
  const knownSessions = new Map<string, FeishuKnownSession>();
  for (const session of sessions) {
    const record = asRecord(session);
    if (readString(record.platform) !== "feishu") {
      continue;
    }

    const key = readString(record.key) ?? readString(record.sessionKey);
    if (key) {
      knownSessions.set(key, {
        key,
        conversationId: readString(record.conversationId),
        rootMessageId: readString(record.rootMessageId)
      });
    }
  }

  return knownSessions;
}

function findMatchingKnownSession(
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  meta: Record<string, unknown>
): FeishuKnownSession | undefined {
  const sessionKey = readString(meta.sessionKey);
  if (!sessionKey) {
    return undefined;
  }

  const knownSession = knownSessions.get(sessionKey);
  if (!knownSession || !sessionMatchesLogCoordinates(knownSession, meta)) {
    return undefined;
  }

  return knownSession;
}

function findMatchingKnownSessionWithRequiredCoordinates(
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  meta: Record<string, unknown>
): FeishuKnownSession | undefined {
  if (!readString(meta.conversationId) || !readString(meta.rootMessageId)) {
    return undefined;
  }

  return findMatchingKnownSession(knownSessions, meta);
}

function sessionMatchesLogCoordinates(
  knownSession: FeishuKnownSession,
  meta: Record<string, unknown>
): boolean {
  const conversationId = readString(meta.conversationId);
  if (conversationId && knownSession.conversationId !== conversationId) {
    return false;
  }

  const rootMessageId = readString(meta.rootMessageId);
  if (rootMessageId && knownSession.rootMessageId !== rootMessageId) {
    return false;
  }

  return true;
}

function coordinatesMatchKnownFeishuSession(
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  meta: Record<string, unknown>
): boolean {
  const conversationId = readString(meta.conversationId);
  const rootMessageId = readString(meta.rootMessageId);
  if (!conversationId || !rootMessageId) {
    return false;
  }

  return [...knownSessions.values()].some((session) =>
    session.conversationId === conversationId &&
    session.rootMessageId === rootMessageId
  );
}

function hasFeishuStoppedActiveTurn(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys?: ReadonlySet<string> | undefined
): boolean {
  return feishuStoppedActiveTurnEvidence(logs, knownSessions, allowedSessionKeys).length > 0;
}

function feishuStoppedActiveTurnEvidence(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys?: ReadonlySet<string> | undefined
): string[] {
  return findFeishuStoppedActiveTurnEvidenceLogs(logs, knownSessions, allowedSessionKeys)
    .slice(-6)
    .map((log) => summarizeLog(log));
}

function findFeishuStoppedActiveTurnEvidenceLogs(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys?: ReadonlySet<string> | undefined
): unknown[] {
  if (allowedSessionKeys && allowedSessionKeys.size === 0) {
    return [];
  }

  const transitionEntries: Array<{
    readonly log: unknown;
    readonly index: number;
    readonly messageId: string;
    readonly sessionKey: string;
  }> = [];
  for (const [index, log] of logs.entries()) {
    const record = asRecord(log);
    const meta = asRecord(record.meta);
    const message = readString(record.message);
    const knownSession = message === "chat.session.resumed"
      ? findMatchingKnownSession(knownSessions, meta)
      : undefined;
    const messageId = readString(meta.messageId);
    if (!knownSession || !messageId) {
      continue;
    }

    transitionEntries.push({
      log,
      index,
      messageId,
      sessionKey: knownSession.key
    });
  }

  const acceptedEntries: Array<{
    readonly log: unknown;
    readonly index: number;
    readonly messageId: string;
    readonly sessionKey: string;
  }> = [];
  for (const [index, log] of logs.entries()) {
    const meta = asRecord(asRecord(log).meta);
    if (
      !logMatches(log, "chat.message.accepted", { platform: "feishu" }) ||
      hasMatchingFeishuIgnoredMessage(logs, meta)
    ) {
      continue;
    }

    const messageId = readString(meta.messageId);
    const conversationId = readString(meta.conversationId);
    const rootMessageId = readString(meta.rootMessageId);
    if (!messageId || !conversationId || !rootMessageId) {
      continue;
    }

    for (const session of knownSessions.values()) {
      if (
        session.conversationId === conversationId &&
        session.rootMessageId === rootMessageId &&
        (!allowedSessionKeys || allowedSessionKeys.has(session.key))
      ) {
        acceptedEntries.push({
          log,
          index,
          messageId,
          sessionKey: session.key
        });
      }
    }
  }

  const evidenceLogs = new Set<unknown>();
  for (const [stoppedIndex, log] of logs.entries()) {
    const record = asRecord(log);
    const meta = asRecord(record.meta);
    const messageId = readString(meta.messageId);
    const knownSession = findMatchingKnownSession(knownSessions, meta);
    if (
      readString(record.message) !== "chat.turn.stopped" ||
      readString(meta.platform) !== "feishu" ||
      !messageId ||
      readBoolean(meta.hadActiveTurn) !== true ||
      !hasActiveTurnId(meta) ||
      !knownSession ||
      (allowedSessionKeys && !allowedSessionKeys.has(knownSession.key))
    ) {
      continue;
    }

    const matchingAcceptedEntries = acceptedEntries.filter((entry) =>
      entry.messageId === messageId &&
      entry.sessionKey === knownSession.key &&
      entry.index < stoppedIndex
    );
    const matchingTransitionEntries = transitionEntries.filter((entry) =>
      entry.messageId === messageId &&
      entry.sessionKey === knownSession.key &&
      entry.index < stoppedIndex &&
      matchingAcceptedEntries.some((accepted) => accepted.index < entry.index)
    );
    if (matchingAcceptedEntries.length === 0 || matchingTransitionEntries.length === 0) {
      continue;
    }

    const acceptedEvidence = matchingAcceptedEntries.filter((accepted) =>
      matchingTransitionEntries.some((transition) => accepted.index < transition.index)
    );
    for (const entry of acceptedEvidence) {
      evidenceLogs.add(entry.log);
    }
    for (const entry of matchingTransitionEntries) {
      evidenceLogs.add(entry.log);
    }
    evidenceLogs.add(log);
  }

  return logs.filter((log) => evidenceLogs.has(log));
}

function hasOverlappingSessionKey(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const sessionKey of left) {
    if (right.has(sessionKey)) {
      return true;
    }
  }

  return false;
}

function hasFeishuDedupedAcceptedMessage(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>
): boolean {
  return logs.some((log) => isFeishuDedupedAcceptedMessageEvidence(logs, log, knownSessions));
}

function feishuDedupedAcceptedMessageEvidence(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>
): string[] {
  return logs
    .filter((log) => isFeishuDedupedAcceptedMessageEvidence(logs, log, knownSessions))
    .slice(-3)
    .map((log) => summarizeLog(log));
}

function isFeishuDedupedAcceptedMessageEvidence(
  logs: readonly unknown[],
  log: unknown,
  knownSessions: ReadonlyMap<string, FeishuKnownSession>
): boolean {
  const acceptedMessages = deliveredFeishuAcceptedMessageMetas(logs, knownSessions);
  if (acceptedMessages.length === 0) {
    return false;
  }

  const record = asRecord(log);
  const meta = asRecord(record.meta);
  if (
    readString(record.message) !== "chat.message.deduped" ||
    readString(meta.platform) !== "feishu"
  ) {
    return false;
  }

  if (hasFeishuAcceptedOrDispatchAfterDeduped(logs, log, meta)) {
    return false;
  }

  return acceptedMessages.some((accepted) =>
    readString(accepted.messageId) === readString(meta.messageId) &&
    readString(accepted.conversationId) === readString(meta.conversationId) &&
    coordinatesMatchWhenPresent(accepted, meta)
  );
}

function hasFeishuAcceptedOrDispatchAfterDeduped(
  logs: readonly unknown[],
  dedupedLog: unknown,
  dedupedMeta: Record<string, unknown>
): boolean {
  const dedupedIndex = logs.indexOf(dedupedLog);
  if (dedupedIndex < 0) {
    return true;
  }

  return logs.some((candidate, index) =>
    index > dedupedIndex &&
    isMatchingFeishuAcceptedOrDispatchMessage(candidate, dedupedMeta)
  );
}

function isMatchingFeishuAcceptedOrDispatchMessage(
  log: unknown,
  sourceMeta: Record<string, unknown>
): boolean {
  const sourceConversationId = readString(sourceMeta.conversationId);
  const sourceMessageId = readString(sourceMeta.messageId);
  if (!sourceConversationId || !sourceMessageId) {
    return true;
  }

  const record = asRecord(log);
  const meta = asRecord(record.meta);
  const message = readString(record.message);
  if (
    readString(meta.platform) !== "feishu" ||
    readString(meta.conversationId) !== sourceConversationId ||
    ![
      "chat.message.accepted",
      "chat.session.created",
      "chat.session.resumed",
      "chat.turn.started",
      "chat.turn.steered"
    ].includes(message ?? "")
  ) {
    return false;
  }

  return readString(meta.messageId) === sourceMessageId ||
    readString(meta.batchId) === sourceMessageId;
}

function deliveredFeishuAcceptedMessageMetas(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>
): Record<string, unknown>[] {
  return logs
    .filter((log) => isDeliveredFeishuAcceptedMessageEvidence(logs, log, knownSessions))
    .map((log) => asRecord(asRecord(log).meta))
    .filter((meta) => Boolean(readString(meta.messageId) && readString(meta.conversationId)));
}

function coordinatesMatchWhenPresent(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const rootMessageId = readString(right.rootMessageId);
  return !rootMessageId || readString(left.rootMessageId) === rootMessageId;
}

function hasFeishuTextReplyForKnownSession(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys?: ReadonlySet<string> | undefined
): boolean {
  return feishuTextReplyEvidence(logs, knownSessions, allowedSessionKeys).length > 0;
}

function feishuTextReplyEvidence(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys?: ReadonlySet<string> | undefined
): string[] {
  if (allowedSessionKeys && allowedSessionKeys.size === 0) {
    return [];
  }

  return logs
    .filter((log) => isFeishuTextReplyEvidence(log, knownSessions, allowedSessionKeys))
    .slice(-3)
    .map((log) => summarizeLog(log));
}

function findFeishuTextReplySessionKeys(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys?: ReadonlySet<string> | undefined
): Set<string> {
  const sessionKeys = new Set<string>();
  if (allowedSessionKeys && allowedSessionKeys.size === 0) {
    return sessionKeys;
  }

  for (const log of logs) {
    const knownSession = findFeishuTextReplyKnownSession(log, knownSessions, allowedSessionKeys);
    if (knownSession) {
      sessionKeys.add(knownSession.key);
    }
  }

  return sessionKeys;
}

function isFeishuTextReplyEvidence(
  log: unknown,
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys?: ReadonlySet<string> | undefined
): boolean {
  return Boolean(findFeishuTextReplyKnownSession(log, knownSessions, allowedSessionKeys));
}

function findFeishuTextReplyKnownSession(
  log: unknown,
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys?: ReadonlySet<string> | undefined
): FeishuKnownSession | undefined {
  const record = asRecord(log);
  const meta = asRecord(record.meta);
  const knownSession = findMatchingKnownSession(knownSessions, meta);
  if (
    readString(record.message) !== "chat.outbound.posted" ||
    readString(meta.platform) !== "feishu" ||
    readString(meta.format) !== "text" ||
    !knownSession ||
    (allowedSessionKeys && !allowedSessionKeys.has(knownSession.key))
  ) {
    return undefined;
  }

  return knownSession;
}

function hasFeishuCompletedTurnForTextReply(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys?: ReadonlySet<string> | undefined
): boolean {
  return findFeishuCompletedTurnForTextReplyEvidenceLogs(logs, knownSessions, allowedSessionKeys).length > 0;
}

function feishuCompletedTurnForTextReplyEvidence(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys?: ReadonlySet<string> | undefined
): string[] {
  return findFeishuCompletedTurnForTextReplyEvidenceLogs(logs, knownSessions, allowedSessionKeys)
    .map((log) => summarizeLog(log));
}

function findFeishuCompletedTurnForTextReplyEvidenceLogs(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys?: ReadonlySet<string> | undefined
): unknown[] {
  if (allowedSessionKeys && allowedSessionKeys.size === 0) {
    return [];
  }

  const turnStarts: Array<{
    readonly log: unknown;
    readonly index: number;
    readonly sessionKey: string;
    readonly turnKey: string;
  }> = [];
  const replies: Array<{
    readonly log: unknown;
    readonly index: number;
    readonly sessionKey: string;
  }> = [];
  const completions: Array<{
    readonly log: unknown;
    readonly index: number;
    readonly sessionKey: string;
    readonly turnKey: string;
  }> = [];

  for (const [index, log] of logs.entries()) {
    const record = asRecord(log);
    const meta = asRecord(record.meta);
    const message = readString(record.message);
    const knownSession = findMatchingKnownSession(knownSessions, meta);

    const replySession = findFeishuTextReplyKnownSession(log, knownSessions, allowedSessionKeys);
    if (replySession) {
      replies.push({
        log,
        index,
        sessionKey: replySession.key
      });
    }

    if (
      message === "chat.turn.completed" &&
      readString(meta.platform) === "feishu" &&
      knownSession &&
      (!allowedSessionKeys || allowedSessionKeys.has(knownSession.key))
    ) {
      const turnKey = feishuTurnCorrelationKey(meta);
      if (turnKey) {
        completions.push({
          log,
          index,
          sessionKey: knownSession.key,
          turnKey
        });
      }
      continue;
    }

    if (
      (message === "chat.turn.started" || message === "chat.turn.steered") &&
      readString(meta.platform) === "feishu" &&
      readString(meta.source) !== "history_recovery" &&
      knownSession &&
      (!allowedSessionKeys || allowedSessionKeys.has(knownSession.key))
    ) {
      const key = feishuTurnCorrelationKey(meta);
      if (!key) {
        continue;
      }
      turnStarts.push({
        log,
        index,
        sessionKey: knownSession.key,
        turnKey: key
      });
    }
  }

  const evidenceLogs = new Set<unknown>();
  for (const completion of completions) {
    const started = turnStarts.find((candidate) =>
      candidate.turnKey === completion.turnKey &&
      candidate.sessionKey === completion.sessionKey &&
      candidate.index < completion.index
    );
    if (!started) {
      continue;
    }

    const reply = replies.find((candidate) =>
      candidate.sessionKey === completion.sessionKey &&
      started.index < candidate.index &&
      candidate.index < completion.index
    );
    if (!reply) {
      continue;
    }

    evidenceLogs.add(started.log);
    evidenceLogs.add(reply.log);
    evidenceLogs.add(completion.log);
  }

  return logs.filter((log) => evidenceLogs.has(log));
}

function feishuTurnCorrelationKey(meta: Record<string, unknown>): string {
  const sessionKey = readString(meta.sessionKey);
  const turnId = readString(meta.turnId);
  const batchId = readString(meta.batchId);
  if (!sessionKey || !turnId || !batchId) {
    return "";
  }

  return `${sessionKey}\u0000${turnId}\u0000${batchId}`;
}

function hasFeishuRecoveredHistory(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>
): boolean {
  const recoveredSessionKeys = findFeishuRecoveredHistorySessionKeys(logs, knownSessions);
  if (recoveredSessionKeys.size === 0) {
    return false;
  }

  return logs.some((log) => isFeishuRecoveredHistoryTurnEvidence(log, knownSessions, recoveredSessionKeys));
}

function feishuRecoveredHistoryEvidence(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>
): string[] {
  const recoveredSessionKeys = findFeishuRecoveredHistorySessionKeys(logs, knownSessions);
  if (recoveredSessionKeys.size === 0) {
    return [];
  }

  return logs
    .filter((log) => isFeishuRecoveredHistoryEvidence(log, knownSessions, recoveredSessionKeys))
    .slice(-4)
    .map((log) => summarizeLog(log));
}

function findFeishuRecoveredHistorySessionKeys(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>
): Set<string> {
  return findFeishuKnownSessionLogKeys(logs, "chat.history.recovered", {}, knownSessions, (meta) =>
    (readNumber(meta.recoveredCount) ?? 0) > 0 &&
    Boolean(readString(meta.messageCursor))
  );
}

function isFeishuRecoveredHistoryEvidence(
  log: unknown,
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  recoveredSessionKeys: ReadonlySet<string>
): boolean {
  const record = asRecord(log);
  const meta = asRecord(record.meta);
  const message = readString(record.message);
  if (message === "chat.history.recovered") {
    const knownSession = findMatchingKnownSession(knownSessions, meta);
    return Boolean(knownSession && recoveredSessionKeys.has(knownSession.key));
  }

  return isFeishuRecoveredHistoryTurnEvidence(log, knownSessions, recoveredSessionKeys);
}

function isFeishuRecoveredHistoryTurnEvidence(
  log: unknown,
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  recoveredSessionKeys: ReadonlySet<string>
): boolean {
  const record = asRecord(log);
  const meta = asRecord(record.meta);
  const message = readString(record.message);
  return (message === "chat.turn.steered" || message === "chat.turn.started") &&
    readString(meta.platform) === "feishu" &&
    readString(meta.source) === "history_recovery" &&
    Boolean(findMatchingKnownSession(knownSessions, meta)) &&
    recoveredSessionKeys.has(readString(meta.sessionKey) ?? "");
}

function hasFeishuCoauthorConfirmedFromCardCallback(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys: ReadonlySet<string>
): boolean {
  const outboundCardMessageIndexesBySession = findFeishuOutboundCardMessageIndexesBySession(
    logs,
    knownSessions,
    allowedSessionKeys
  );
  const callbackRevisionIndexesBySession = findFeishuCoauthorCallbackRevisionIndexes(
    logs,
    knownSessions,
    allowedSessionKeys,
    outboundCardMessageIndexesBySession
  );
  if (callbackRevisionIndexesBySession.size === 0) {
    return false;
  }

  return hasFeishuRevisionEntries(
    findFeishuCoauthorConfirmedRevisionIndexes(logs, knownSessions, callbackRevisionIndexesBySession)
  );
}

function feishuCoauthorCardEvidence(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys: ReadonlySet<string>
): string[] {
  const outboundCardMessageIndexesBySession = findFeishuOutboundCardMessageIndexesBySession(
    logs,
    knownSessions,
    allowedSessionKeys
  );
  const callbackRevisionIndexesBySession = findFeishuCoauthorCallbackRevisionIndexes(
    logs,
    knownSessions,
    allowedSessionKeys,
    outboundCardMessageIndexesBySession
  );
  const confirmedRevisionIndexesBySession = findFeishuCoauthorConfirmedRevisionIndexes(
    logs,
    knownSessions,
    callbackRevisionIndexesBySession
  );
  if (!hasFeishuRevisionEntries(confirmedRevisionIndexesBySession)) {
    return [
      `requiredSession=group_at outboundCardSessionCount=${outboundCardMessageIndexesBySession.size}`,
      `outboundCardMessageCount=${countFeishuOutboundCardMessages(outboundCardMessageIndexesBySession)}`
    ];
  }

  const observed = logs
    .filter((log, index) => {
      const callback = readFeishuCoauthorCallbackRevision(
        log,
        index,
        knownSessions,
        allowedSessionKeys,
        outboundCardMessageIndexesBySession
      );
      if (callback) {
        return confirmedRevisionIndexesBySession.get(callback.sessionKey)?.has(callback.candidateRevision) === true;
      }

      const confirmation = readFeishuCoauthorConfirmedRevision(
        log,
        index,
        knownSessions,
        callbackRevisionIndexesBySession
      );
      return Boolean(
        confirmation &&
        confirmedRevisionIndexesBySession.get(confirmation.sessionKey)?.has(confirmation.candidateRevision)
      );
    })
    .slice(-4)
    .map((log) => summarizeLog(log));

  return [
    `requiredSession=group_at outboundCardSessionCount=${outboundCardMessageIndexesBySession.size}`,
    `outboundCardMessageCount=${countFeishuOutboundCardMessages(outboundCardMessageIndexesBySession)}`,
    ...observed
  ];
}

function findFeishuCoauthorConfirmedRevisionIndexes(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  callbackRevisionIndexesBySession: ReadonlyMap<string, ReadonlyMap<number, number>>
): Map<string, Map<number, number>> {
  const revisionIndexesBySession = new Map<string, Map<number, number>>();
  for (const [index, log] of logs.entries()) {
    const revision = readFeishuCoauthorConfirmedRevision(log, index, knownSessions, callbackRevisionIndexesBySession);
    if (!revision) {
      continue;
    }

    const revisionIndexes = revisionIndexesBySession.get(revision.sessionKey) ?? new Map<number, number>();
    const existingIndex = revisionIndexes.get(revision.candidateRevision);
    if (existingIndex === undefined || index < existingIndex) {
      revisionIndexes.set(revision.candidateRevision, index);
    }
    revisionIndexesBySession.set(revision.sessionKey, revisionIndexes);
  }

  return revisionIndexesBySession;
}

function readFeishuCoauthorConfirmedRevision(
  log: unknown,
  confirmationIndex: number,
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  callbackRevisionIndexesBySession: ReadonlyMap<string, ReadonlyMap<number, number>>
): { readonly sessionKey: string; readonly candidateRevision: number } | undefined {
  const record = asRecord(log);
  const meta = asRecord(record.meta);
  const knownSession = findMatchingKnownSessionWithRequiredCoordinates(knownSessions, meta);
  const candidateRevision = readNumber(meta.candidateRevision) ?? 0;
  const callbackIndex = knownSession
    ? callbackRevisionIndexesBySession.get(knownSession.key)?.get(candidateRevision)
    : undefined;
  if (
    readString(record.message) !== "chat.coauthor.confirmed" ||
    readString(meta.platform) !== "feishu" ||
    !knownSession ||
    candidateRevision <= 0 ||
    callbackIndex === undefined ||
    callbackIndex >= confirmationIndex ||
    (readNumber(meta.confirmedCount) ?? 0) <= 0
  ) {
    return undefined;
  }

  return {
    sessionKey: knownSession.key,
    candidateRevision
  };
}

function hasFeishuRevisionEntries(
  revisionIndexesBySession: ReadonlyMap<string, ReadonlyMap<number, number>>
): boolean {
  for (const revisionIndexes of revisionIndexesBySession.values()) {
    if (revisionIndexes.size > 0) {
      return true;
    }
  }

  return false;
}

function findFeishuCoauthorCallbackRevisionIndexes(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys: ReadonlySet<string>,
  outboundCardMessageIndexesBySession: ReadonlyMap<string, ReadonlyMap<string, number>>
): Map<string, Map<number, number>> {
  const revisionIndexesBySession = new Map<string, Map<number, number>>();
  for (const [index, log] of logs.entries()) {
    const revision = readFeishuCoauthorCallbackRevision(
      log,
      index,
      knownSessions,
      allowedSessionKeys,
      outboundCardMessageIndexesBySession
    );
    if (!revision) {
      continue;
    }

    const revisionIndexes = revisionIndexesBySession.get(revision.sessionKey) ?? new Map<number, number>();
    const existingIndex = revisionIndexes.get(revision.candidateRevision);
    if (existingIndex === undefined || index < existingIndex) {
      revisionIndexes.set(revision.candidateRevision, index);
    }
    revisionIndexesBySession.set(revision.sessionKey, revisionIndexes);
  }

  return revisionIndexesBySession;
}

function readFeishuCoauthorCallbackRevision(
  log: unknown,
  callbackIndex: number,
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys: ReadonlySet<string>,
  outboundCardMessageIndexesBySession: ReadonlyMap<string, ReadonlyMap<string, number>>
): { readonly sessionKey: string; readonly candidateRevision: number } | undefined {
  const record = asRecord(log);
  const meta = asRecord(record.meta);
  if (
    readString(record.message) !== "chat.card.callback.received" ||
    readString(meta.platform) !== "feishu" ||
    readString(meta.kind) !== "coauthor_confirm_all"
  ) {
    return undefined;
  }

  const knownSession = findMatchingKnownSessionWithRequiredCoordinates(knownSessions, meta);
  const candidateRevision = readNumber(meta.candidateRevision) ?? 0;
  if (
    !knownSession ||
    !allowedSessionKeys.has(knownSession.key) ||
    !hasMatchingFeishuOutboundCardMessage(meta, knownSession.key, outboundCardMessageIndexesBySession, callbackIndex) ||
    candidateRevision <= 0
  ) {
    return undefined;
  }

  return {
    sessionKey: knownSession.key,
    candidateRevision
  };
}

function hasFeishuCardCallbackForBrokerPostedGroupCard(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys: ReadonlySet<string>
): boolean {
  const outboundCardMessageIndexesBySession = findFeishuOutboundCardMessageIndexesBySession(
    logs,
    knownSessions,
    allowedSessionKeys
  );
  return logs.some((log, index) =>
    isFeishuCardCallbackEvidence(log, index, knownSessions, allowedSessionKeys, outboundCardMessageIndexesBySession)
  );
}

function feishuCardCallbackEvidence(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys: ReadonlySet<string>
): string[] {
  const outboundCardMessageIndexesBySession = findFeishuOutboundCardMessageIndexesBySession(
    logs,
    knownSessions,
    allowedSessionKeys
  );
  const observed = logs
    .filter((log, index) =>
      isFeishuCardCallbackEvidence(log, index, knownSessions, allowedSessionKeys, outboundCardMessageIndexesBySession)
    )
    .slice(-3)
    .map((log) => summarizeLog(log));

  return [
    `requiredSession=group_at outboundCardSessionCount=${outboundCardMessageIndexesBySession.size}`,
    `outboundCardMessageCount=${countFeishuOutboundCardMessages(outboundCardMessageIndexesBySession)}`,
    ...observed
  ];
}

function isFeishuCardCallbackEvidence(
  log: unknown,
  callbackIndex: number,
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys: ReadonlySet<string>,
  outboundCardMessageIndexesBySession: ReadonlyMap<string, ReadonlyMap<string, number>>
): boolean {
  const record = asRecord(log);
  const meta = asRecord(record.meta);
  if (
    readString(record.message) !== "chat.card.callback.received" ||
    readString(meta.platform) !== "feishu"
  ) {
    return false;
  }

  const knownSession = findMatchingKnownSessionWithRequiredCoordinates(knownSessions, meta);
  return Boolean(
    knownSession &&
    allowedSessionKeys.has(knownSession.key) &&
    hasMatchingFeishuOutboundCardMessage(meta, knownSession.key, outboundCardMessageIndexesBySession, callbackIndex)
  );
}

function findFeishuOutboundCardMessageIndexesBySession(
  logs: readonly unknown[],
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  allowedSessionKeys: ReadonlySet<string>
): Map<string, Map<string, number>> {
  const messageIndexesBySession = new Map<string, Map<string, number>>();
  for (const [index, log] of logs.entries()) {
    const record = asRecord(log);
    const meta = asRecord(record.meta);
    const messageId = readString(meta.messageId);
    if (
      readString(record.message) !== "chat.outbound.posted" ||
      readString(meta.platform) !== "feishu" ||
      readString(meta.format) !== "card" ||
      !messageId
    ) {
      continue;
    }

    const knownSession = findMatchingKnownSessionWithRequiredCoordinates(knownSessions, meta);
    if (knownSession && allowedSessionKeys.has(knownSession.key)) {
      const messageIndexes = messageIndexesBySession.get(knownSession.key) ?? new Map<string, number>();
      const existingIndex = messageIndexes.get(messageId);
      if (existingIndex === undefined || index < existingIndex) {
        messageIndexes.set(messageId, index);
      }
      messageIndexesBySession.set(knownSession.key, messageIndexes);
    }
  }

  return messageIndexesBySession;
}

function hasMatchingFeishuOutboundCardMessage(
  callbackMeta: Record<string, unknown>,
  sessionKey: string,
  outboundCardMessageIndexesBySession: ReadonlyMap<string, ReadonlyMap<string, number>>,
  callbackIndex: number
): boolean {
  const callbackMessageId = readString(callbackMeta.messageId);
  const outboundCardIndexes = outboundCardMessageIndexesBySession.get(sessionKey);
  if (!outboundCardIndexes) {
    return false;
  }

  if (callbackMessageId && callbackMessageId !== "unknown") {
    const outboundCardIndex = outboundCardIndexes.get(callbackMessageId);
    return outboundCardIndex !== undefined && outboundCardIndex < callbackIndex;
  }

  return [...outboundCardIndexes.values()].some((outboundCardIndex) => outboundCardIndex < callbackIndex);
}

function countFeishuOutboundCardMessages(
  outboundCardMessageIndexesBySession: ReadonlyMap<string, ReadonlyMap<string, number>>
): number {
  let count = 0;
  for (const messageIndexes of outboundCardMessageIndexesBySession.values()) {
    count += messageIndexes.size;
  }

  return count;
}

function findFeishuKnownSessionLogKeys(
  logs: readonly unknown[],
  message: string,
  metaExpectation: Record<string, string>,
  knownSessions: ReadonlyMap<string, FeishuKnownSession>,
  predicate?: (meta: Record<string, unknown>) => boolean
): Set<string> {
  const sessionKeys = new Set<string>();
  for (const log of logs) {
    const record = asRecord(log);
    const meta = asRecord(record.meta);
    if (
      readString(record.message) !== message ||
      readString(meta.platform) !== "feishu" ||
      !Object.entries(metaExpectation).every(([key, value]) => readString(meta[key]) === value) ||
      (predicate && !predicate(meta))
    ) {
      continue;
    }

    const knownSession = findMatchingKnownSession(knownSessions, meta);
    if (knownSession) {
      sessionKeys.add(knownSession.key);
    }
  }

  return sessionKeys;
}

function findFeishuLogSessionKeys(
  logs: readonly unknown[],
  message: string,
  metaExpectation: Record<string, string>,
  predicate?: (meta: Record<string, unknown>) => boolean
): Set<string> {
  const sessionKeys = new Set<string>();
  for (const log of logs) {
    const record = asRecord(log);
    const meta = asRecord(record.meta);
    if (
      readString(record.message) !== message ||
      readString(meta.platform) !== "feishu" ||
      !Object.entries(metaExpectation).every(([key, value]) => readString(meta[key]) === value) ||
      (predicate && !predicate(meta))
    ) {
      continue;
    }

    const sessionKey = readString(meta.sessionKey);
    if (sessionKey) {
      sessionKeys.add(sessionKey);
    }
  }

  return sessionKeys;
}

function hasFeishuLongConnectionReadyEvidence(feishu: Record<string, unknown>, logs: readonly unknown[]): boolean {
  const connection = asRecord(feishu.connection);
  const adminConnectionReady =
    readString(connection.mode) === "long_connection" &&
    readBoolean(connection.connected) === true &&
    Boolean(readString(connection.lastConnectedAt));

  return adminConnectionReady ||
    hasLog(logs, "chat.platform.ready", {
      platform: "feishu",
      source: "long_connection"
    });
}

function hasSlackSocketModeReadyEvidence(slack: Record<string, unknown>, logs: readonly unknown[]): boolean {
  const connection = asRecord(slack.connection);
  const adminConnectionReady =
    readString(connection.mode) === "socket_mode" &&
    readBoolean(connection.connected) === true &&
    Boolean(readString(connection.lastConnectedAt));

  return adminConnectionReady ||
    hasLog(logs, "chat.platform.ready", {
      platform: "slack",
      source: "socket_mode"
    });
}

function hasSlackMessageRoundtrip(logs: readonly unknown[]): boolean {
  return slackMessageRoundtripEvidence(logs).length > 0;
}

function slackMessageRoundtripEvidence(logs: readonly unknown[]): string[] {
  return findSlackMessageRoundtripEvidenceLogs(logs).map((log) => summarizeLog(log));
}

function findSlackMessageRoundtripEvidenceLogs(logs: readonly unknown[]): unknown[] {
  const acceptedMessages = logs
    .map((log, index) => ({
      index,
      log,
      meta: asRecord(asRecord(log).meta),
      accepted: logMatches(log, "chat.message.accepted", { platform: "slack" })
    }))
    .filter(({ meta }) =>
      Boolean(
        readString(meta.sessionKey) &&
        readString(meta.conversationId) &&
        readString(meta.rootMessageId) &&
        readString(meta.messageId)
      )
    )
    .filter(({ accepted }) => accepted);
  if (acceptedMessages.length === 0) {
    return [];
  }

  let evidenceLogs: readonly unknown[] = [];
  for (const [outboundIndex, log] of logs.entries()) {
    const record = asRecord(log);
    const meta = asRecord(record.meta);
    if (
      readString(record.message) !== "chat.outbound.posted" ||
      readString(meta.platform) !== "slack" ||
      readString(meta.format) !== "text" ||
      !readString(meta.sessionKey) ||
      !readString(meta.conversationId) ||
      !readString(meta.rootMessageId) ||
      !readString(meta.messageId)
    ) {
      continue;
    }

    const accepted = acceptedMessages.find((candidate) =>
      candidate.index < outboundIndex &&
      readString(candidate.meta.sessionKey) === readString(meta.sessionKey) &&
      readString(candidate.meta.conversationId) === readString(meta.conversationId) &&
      readString(candidate.meta.rootMessageId) === readString(meta.rootMessageId)
    );
    if (accepted) {
      evidenceLogs = [accepted.log, log];
    }
  }

  if (evidenceLogs.length === 0) {
    return [];
  }

  const selected = new Set(evidenceLogs);
  return logs.filter((log) => selected.has(log));
}

function hasAdminPlatformHealthContract(
  slack: Record<string, unknown>,
  feishu: Record<string, unknown>
): boolean {
  return missingAdminPlatformHealthFields(slack, feishu).length === 0;
}

function adminPlatformHealthEvidence(
  slack: Record<string, unknown>,
  feishu: Record<string, unknown>
): string[] {
  const slackConnection = asRecord(slack.connection);
  const feishuConnection = asRecord(feishu.connection);
  const permissionStatuses = readPermissionStatusEntries(feishu);
  const missing = missingAdminPlatformHealthFields(slack, feishu);

  return [
    `slack.state=${readString(slack.state) ?? "unknown"}`,
    `slack.connection.mode=${readString(slackConnection.mode) ?? "unknown"}`,
    `feishu.state=${readString(feishu.state) ?? "unknown"}`,
    `feishu.connection.mode=${readString(feishuConnection.mode) ?? "unknown"}`,
    `feishu.permissions=${permissionStatuses.length > 0 ? permissionStatuses.join(",") : "missing"}`,
    missing.length === 0
      ? "admin platform health contract is present"
      : `missing admin health fields: ${missing.join(", ")}`
  ];
}

const ADMIN_FEISHU_PERMISSION_STATUS_REQUIREMENTS = [
  ["bot_identity", "configured"],
  ["im:message.group_msg", "verified"],
  ["im:message:send_as_bot", "configured"]
] as const;

function missingAdminPlatformHealthFields(
  slack: Record<string, unknown>,
  feishu: Record<string, unknown>
): string[] {
  const slackConnection = asRecord(slack.connection);
  const feishuConnection = asRecord(feishu.connection);
  const permissionStatuses = readPermissionStatusMap(feishu);
  const missing: string[] = [];
  const slackState = readString(slack.state);
  const feishuState = readString(feishu.state);

  if (!isPlatformHealthState(slackState)) {
    missing.push("platforms.slack.state");
  }
  if (readString(slackConnection.mode) !== "socket_mode") {
    missing.push("platforms.slack.connection.mode=socket_mode");
  }
  if (typeof slackConnection.connected !== "boolean") {
    missing.push("platforms.slack.connection.connected");
  } else {
    if (slackState === "ready" && readBoolean(slackConnection.connected) !== true) {
      missing.push("platforms.slack.connection.connected=true");
    }
    if (readBoolean(slackConnection.connected) === true && !readString(slackConnection.lastConnectedAt)) {
      missing.push("platforms.slack.connection.lastConnectedAt");
    }
  }
  if (!isPlatformHealthState(feishuState)) {
    missing.push("platforms.feishu.state");
  }
  if (readString(feishuConnection.mode) !== "long_connection") {
    missing.push("platforms.feishu.connection.mode=long_connection");
  }
  if (typeof feishuConnection.connected !== "boolean") {
    missing.push("platforms.feishu.connection.connected");
  } else {
    if (feishuState === "ready" && readBoolean(feishuConnection.connected) !== true) {
      missing.push("platforms.feishu.connection.connected=true");
    }
    if (readBoolean(feishuConnection.connected) === true && !readString(feishuConnection.lastConnectedAt)) {
      missing.push("platforms.feishu.connection.lastConnectedAt");
    }
  }
  for (const [permissionName, expectedStatus] of ADMIN_FEISHU_PERMISSION_STATUS_REQUIREMENTS) {
    if (!permissionStatuses.has(permissionName)) {
      missing.push(`platforms.feishu.permissions.${permissionName}`);
      continue;
    }
    if (permissionStatuses.get(permissionName) !== expectedStatus) {
      missing.push(`platforms.feishu.permissions.${permissionName}.status=${expectedStatus}`);
    }
  }
  if (
    (feishuState === "degraded" || feishuState === "failed") &&
    !readString(feishu.degradedReason) &&
    !readString(asRecord(feishu.lastError).message)
  ) {
    missing.push("platforms.feishu.degradedReason_or_lastError");
  }

  return missing;
}

function readPermissionStatusEntries(platformStatus: Record<string, unknown>): string[] {
  return asArray(platformStatus.permissions)
    .map((entry) => {
      const permission = asRecord(entry);
      const name = readString(permission.name)?.trim();
      if (!name) {
        return undefined;
      }

      return `${name}:${readPermissionStatus(permission) ?? "missing"}`;
    })
    .filter((status): status is string => Boolean(status));
}

function readPermissionStatusMap(platformStatus: Record<string, unknown>): Map<string, string | undefined> {
  const statuses = new Map<string, string | undefined>();
  for (const entry of asArray(platformStatus.permissions)) {
    const permission = asRecord(entry);
    const name = readString(permission.name)?.trim();
    if (name) {
      statuses.set(name, readPermissionStatus(permission));
    }
  }

  return statuses;
}

function readPermissionStatus(permission: Record<string, unknown>): string | undefined {
  return readString(permission.status)?.trim().toLowerCase();
}

function isPlatformHealthState(value: string | undefined): boolean {
  return value === "disabled" ||
    value === "starting" ||
    value === "ready" ||
    value === "degraded" ||
    value === "failed";
}

function connectionEvidence(platformStatus: Record<string, unknown>): string[] {
  const connection = asRecord(platformStatus.connection);
  return [
    `connection.mode=${readString(connection.mode) ?? "unknown"}`,
    `connection.connected=${String(connection.connected)}`,
    `connection.lastConnectedAt=${readString(connection.lastConnectedAt) ?? "missing"}`
  ];
}

function platformReadyLogEvidence(logs: readonly unknown[], platform: string, source: string): string[] {
  return logEvidence(logs, "chat.platform.ready", { platform, source });
}

function logEvidence(logs: readonly unknown[], message: string, meta: Record<string, string>): string[] {
  return logs
    .filter((log) => logMatches(log, message, meta))
    .slice(-3)
    .map((log) => summarizeLog(log));
}

function logMatches(log: unknown, message: string, meta: Record<string, string>): boolean {
  const record = asRecord(log);
  const logMeta = asRecord(record.meta);
  if (readString(record.message) !== message) {
    return false;
  }

  return Object.entries(meta).every(([key, value]) => readString(logMeta[key]) === value);
}

function sessionEvidence(sessions: readonly unknown[], platform: string): string[] {
  return sessions
    .filter((session) => readString(asRecord(session).platform) === platform)
    .slice(0, 3)
    .map((session) => {
      const record = asRecord(session);
      return [
        `session=${readString(record.key) ?? "unknown"}`,
        `conversation=${readString(record.conversationId) ?? "unknown"}`,
        `root=${readString(record.rootMessageId) ?? "unknown"}`
      ].join(" ");
    });
}

function summarizeLog(log: unknown): string {
  const record = asRecord(log);
  const meta = asRecord(record.meta);
  return [
    readString(record.message) ?? "unknown",
    readString(meta.platform),
    readString(meta.source),
    readString(meta.sessionKey),
    readString(meta.conversationId),
    readString(meta.rootMessageId),
    readString(meta.messageId),
    readString(meta.fileId),
    readString(meta.route),
    readString(meta.ignoredReason),
    readString(meta.msgType),
    readString(meta.degradedReason)
  ].filter(Boolean).join(" ");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readEnvBoolean(value: string | undefined, fallback: boolean): boolean | undefined {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  return undefined;
}

function normalizeKnownEnvValue(value: string | undefined, allowedValues: readonly string[]): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return allowedValues.includes(normalized) ? normalized : "invalid";
}

function formatEnvEnumEvidence(
  value: string | undefined,
  fallback: string,
  allowedValues: readonly string[]
): string {
  const normalized = normalizeKnownEnvValue(value, allowedValues);
  if (!normalized) {
    return `${fallback}(default)`;
  }

  return normalized;
}

function formatEnvBooleanEvidence(value: string | undefined, fallback: boolean): string {
  if (value === undefined || value.trim() === "") {
    return `${String(fallback)}(default)`;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "false" ? normalized : "invalid";
}

function normalizeFeishuApiBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const pathname = url.pathname.replace(/\/+$/u, "");
    if (pathname && pathname !== "/open-apis") {
      return undefined;
    }
    if (url.search || url.hash) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function formatFeishuApiBaseEvidence(value: string): string {
  try {
    const url = new URL(value);
    const pathname = url.pathname.replace(/\/+$/u, "");
    const safePath = !pathname
      ? ""
      : pathname === "/open-apis"
        ? "/open-apis"
        : "/unsupported-path";
    const suffix = url.search || url.hash ? " (query/hash omitted)" : "";
    return `${url.origin}${safePath}${suffix}`;
  } catch {
    return "invalid_url";
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(formatFeishuSmokeCliError(error));
    process.exitCode = 1;
  });
}
