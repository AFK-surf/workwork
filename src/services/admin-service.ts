import fs from "node:fs/promises";
import path from "node:path";

import type { AppConfig } from "../config.js";
import type { PersistedBackgroundJob, PersistedInboundMessage, SlackSessionRecord } from "../types.js";
import type { SessionManager } from "./session-manager.js";
import type { ChatPlatform } from "./chat/chat-types.js";
import type {
  AuthProfileService,
  AuthProfileSummary,
  AuthProfilesStatus
} from "./auth-profile-service.js";
import type { GitHubAuthorMappingService } from "./github-author-mapping-service.js";
import type { RuntimeControl } from "./runtime-control.js";
import type {
  DeployWorkerOptions,
  RollbackWorkerOptions,
  WorkerDeploymentService,
  WorkerDeploymentStatus,
  WorkerReleaseInfo
} from "./deploy/worker-deployment-service.js";
import {
  serializeAccountError,
  serializeAccountSummary,
  serializeRateLimits,
  serializeRateLimitsError,
  type SerializedAccountStatus,
  type SerializedRateLimitsStatus
} from "./codex/account-status.js";

interface FileInfo {
  readonly exists: boolean;
  readonly path: string;
  readonly size?: number | undefined;
  readonly mtime?: string | undefined;
}

type PlatformHealthState = "disabled" | "starting" | "ready" | "degraded" | "failed";

interface PlatformHealthStatus {
  readonly platform: "slack" | "feishu";
  readonly enabled: boolean;
  readonly state: PlatformHealthState;
  readonly startupRequired: boolean;
  readonly groupMessageMode?: "all" | "at_only" | undefined;
  readonly allMessageDeliveryVerified?: boolean | undefined;
  readonly connection?: {
    readonly mode: "socket_mode" | "long_connection" | "http";
    readonly connected: boolean;
    readonly lastConnectedAt?: string | undefined;
    readonly lastDisconnectedAt?: string | undefined;
  } | undefined;
  readonly permissions?: readonly {
    readonly name: string;
    readonly requiredFor: string;
    readonly status: "unknown" | "configured" | "verified" | "missing";
  }[] | undefined;
  readonly degradedReason?: string | undefined;
  readonly lastEvent?: {
    readonly eventId?: string | undefined;
    readonly messageId?: string | undefined;
    readonly receivedAt: string;
  } | undefined;
  readonly lastError?: {
    readonly at: string;
    readonly errorClass: string;
    readonly message: string;
  } | undefined;
}

interface PlatformLogSnapshot {
  readonly lastReadyAt?: string | undefined;
  readonly lastStartingAt?: string | undefined;
  readonly lastDisconnectedAt?: string | undefined;
  readonly lastDegraded?: {
    readonly at: string;
    readonly reason?: string | undefined;
  } | undefined;
  readonly lastStartupFailureAt?: string | undefined;
  readonly lastEvent?: PlatformHealthStatus["lastEvent"];
  readonly lastError?: PlatformHealthStatus["lastError"];
}

const ADMIN_SAFE_LOG_META_FIELDS = new Set([
  "ackDurationMs",
  "attempt",
  "attachmentId",
  "batchId",
  "candidateRevision",
  "codexThreadId",
  "confirmedCount",
  "conversationId",
  "conversationKind",
  "degradedReason",
  "durationMs",
  "errorClass",
  "eventId",
  "fileId",
  "format",
  "groupMessageMode",
  "hadActiveTurn",
  "handler",
  "ignoredReason",
  "jobId",
  "kind",
  "messageCursor",
  "messageId",
  "msgType",
  "payloadRef",
  "permission",
  "platform",
  "platformThreadId",
  "recoveredCount",
  "rootMessageId",
  "route",
  "senderKind",
  "sessionKey",
  "source",
  "startupRequired",
  "statusCode",
  "turnId"
]);
const SAFE_ADMIN_LOG_TOKEN = /^[a-z][a-z0-9_.:-]*$/u;
const SAFE_ADMIN_LOG_TIMESTAMP = /^[0-9TZ:.+-]+$/u;
const SECRET_LIKE_ADMIN_LOG_META_VALUE =
  /\b(?:xox[abprs]-[A-Za-z0-9_-]+|xapp-[A-Za-z0-9_-]+|Bearer\s+\S+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/iu;
const SENTINEL_LIKE_ADMIN_PATH_VALUE = /\b[A-Z0-9_]*(?:SECRET|BODY|PAYLOAD)[A-Z0-9_]*\b/u;

export class AdminService {
  constructor(
    private readonly options: {
      readonly config: AppConfig;
      readonly sessions: SessionManager;
      readonly runtime: RuntimeControl;
      readonly authProfiles: AuthProfileService;
      readonly githubAuthorMappings: GitHubAuthorMappingService;
      readonly startedAt: Date;
      readonly deployment?: WorkerDeploymentService | undefined;
    }
  ) {}

  getAdminUiBootstrap(): {
    readonly tokenConfigured: boolean;
    readonly serviceName: string;
  } {
    return {
      tokenConfigured: Boolean(this.options.config.brokerAdminToken),
      serviceName: this.options.config.serviceName
    };
  }

  async getStatus(options?: {
    readonly platform?: ChatPlatform | undefined;
  }): Promise<Record<string, unknown>> {
    await this.#refreshSessions();
    await this.options.githubAuthorMappings.load();
    const loadedSessions = this.options.sessions
      .listSessions()
      .sort((left, right) => compareSessions(left, right));
    const allSessions = options?.platform
      ? loadedSessions.filter((session) => platformForSession(session) === options.platform)
      : loadedSessions;
    const visibleSessionKeys = new Set(allSessions.map((session) => session.key));
    const activeSessions = allSessions.filter((session) => Boolean(session.activeTurnId));
    const openInbound = this.options.sessions
      .listInboundMessages({
        status: ["pending", "inflight"]
      })
      .filter((message) => visibleSessionKeys.has(message.sessionKey))
      .sort((left, right) => String(left.updatedAt ?? "").localeCompare(String(right.updatedAt ?? "")));
    const backgroundJobs = this.options.sessions
      .listBackgroundJobs()
      .filter((job) => visibleSessionKeys.has(job.sessionKey))
      .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
    const allGitHubAuthorMappings = this.options.githubAuthorMappings.listMappings();
    const githubAuthorMappings = options?.platform
      ? allGitHubAuthorMappings.filter((mapping) => (mapping.platform ?? "slack") === options.platform)
      : allGitHubAuthorMappings;
    const openInboundBySession = groupBySession(openInbound);
    const jobsBySession = groupBySession(backgroundJobs);
    const sessionSummaries = allSessions.slice(0, 50).map((session) =>
      this.#summarizeSession(session, {
        inbound: openInboundBySession.get(session.key) ?? [],
        jobs: jobsBySession.get(session.key) ?? []
      })
    );
    const [account, rateLimits, deployment] = await Promise.all([
      this.#readAccountSummary(),
      this.#readAccountRateLimits(),
      this.options.deployment?.getStatus() ?? Promise.resolve(null)
    ]);
    const authProfiles = await this.options.authProfiles.listProfilesStatus({
      activeSnapshot:
        account.ok && rateLimits.ok
          ? {
              source: "runtime",
              checkedAt: new Date().toISOString(),
              account,
              rateLimits
            }
          : undefined
    });
    const backgroundJobCount = backgroundJobs.length;
    const runningBackgroundJobCount = backgroundJobs.filter((job) => job.status === "running").length;
    const failedBackgroundJobCount = backgroundJobs.filter((job) => job.status === "failed").length;
    const platformLogs = await this.#readRecentBrokerLogs(200);

    return {
      service: {
        name: this.options.config.serviceName,
        mode: this.options.deployment ? "admin" : "combined",
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        startedAt: this.options.startedAt.toISOString(),
        port: this.options.config.port,
        brokerHttpBaseUrl: this.options.config.brokerHttpBaseUrl,
        workerBaseUrl: this.options.config.workerBaseUrl,
        sessionsRoot: summarizeAdminPath(this.options.config.sessionsRoot),
        reposRoot: summarizeAdminPath(this.options.config.reposRoot),
        codexHome: summarizeAdminPath(this.options.config.codexHome),
        adminTokenConfigured: Boolean(this.options.config.brokerAdminToken)
      },
      authFiles: {
        authJson: await this.#fileInfo(path.join(this.options.config.codexHome, "auth.json")),
        credentialsJson: await this.#fileInfo(path.join(this.options.config.codexHome, ".credentials.json")),
        configToml: await this.#fileInfo(path.join(this.options.config.codexHome, "config.toml"))
      },
      authProfiles: summarizeAuthProfilesStatus(authProfiles),
      githubAuthorMappings: {
        count: githubAuthorMappings.length,
        mappings: githubAuthorMappings
      },
      account,
      rateLimits,
      platforms: this.#summarizePlatforms(platformLogs),
      deployment: deployment ? summarizeDeploymentStatus(deployment) : null,
      state: {
        platform: options?.platform ?? "all",
        sessionCount: allSessions.length,
        activeCount: activeSessions.length,
        activeSessions: activeSessions.map((session) => this.#summarizeActiveSession(session)),
        openInboundCount: openInbound.length,
        openInbound: openInbound.slice(0, 25).map((message) => this.#summarizeInbound(message)),
        backgroundJobCount,
        runningBackgroundJobCount,
        failedBackgroundJobCount,
        sessions: sessionSummaries,
        recentBrokerLogs: platformLogs
      }
    };
  }

  async addAuthProfile(options: {
    readonly name?: string | undefined;
    readonly authJsonContent: string;
  }): Promise<Record<string, unknown>> {
    const profile = await this.options.authProfiles.addProfile(options);
    return {
      ok: true,
      profile: summarizeAuthProfileSummary(profile),
      status: await this.getStatus()
    };
  }

  async deleteAuthProfile(options: {
    readonly name: string;
  }): Promise<Record<string, unknown>> {
    await this.options.authProfiles.deleteProfile(options.name);
    return {
      ok: true,
      deletedProfile: options.name,
      status: await this.getStatus()
    };
  }

  async activateAuthProfile(options: {
    readonly name: string;
    readonly allowActive: boolean;
  }): Promise<Record<string, unknown>> {
    await this.#assertSafeToInterrupt(options.allowActive, "auth profile switch");
    const activated = await this.options.authProfiles.activateProfile(options.name);
    await this.options.runtime.restartRuntime(`admin auth profile switch: ${activated.name}`);
    return {
      ok: true,
      activatedProfile: activated.name,
      status: await this.getStatus()
    };
  }

  async deployWorker(options: {
    readonly ref: string;
    readonly allowActive: boolean;
  }): Promise<Record<string, unknown>> {
    if (!this.options.deployment) {
      throw new Error("Worker deployment is not configured for this runtime.");
    }

    await this.#assertSafeToInterrupt(options.allowActive, "deploy");
    const deployment = await this.options.deployment.deploy({
      ref: options.ref
    } satisfies DeployWorkerOptions);
    return {
      ok: true,
      deployment,
      status: await this.getStatus()
    };
  }

  async rollbackWorker(options: {
    readonly ref?: string | undefined;
    readonly allowActive: boolean;
  }): Promise<Record<string, unknown>> {
    if (!this.options.deployment) {
      throw new Error("Worker deployment is not configured for this runtime.");
    }

    await this.#assertSafeToInterrupt(options.allowActive, "rollback");
    const deployment = await this.options.deployment.rollback({
      ref: options.ref
    } satisfies RollbackWorkerOptions);
    return {
      ok: true,
      deployment,
      status: await this.getStatus()
    };
  }

  async upsertGitHubAuthorMapping(options: {
    readonly platform?: ChatPlatform | undefined;
    readonly userId?: string | undefined;
    readonly slackUserId?: string | undefined;
    readonly githubAuthor: string;
  }): Promise<Record<string, unknown>> {
    await this.options.githubAuthorMappings.load();
    const mapping = await this.options.githubAuthorMappings.upsertManualMapping({
      platform: options.platform,
      userId: options.userId,
      slackUserId: options.slackUserId,
      githubAuthor: options.githubAuthor
    });
    return {
      ok: true,
      mapping,
      status: await this.getStatus()
    };
  }

  async deleteGitHubAuthorMapping(options: {
    readonly platform?: ChatPlatform | undefined;
    readonly slackUserId: string;
  }): Promise<Record<string, unknown>> {
    await this.options.githubAuthorMappings.load();
    await this.options.githubAuthorMappings.deleteMappingForUser({
      platform: options.platform ?? "slack",
      userId: options.slackUserId
    });
    return {
      ok: true,
      slackUserId: options.slackUserId,
      status: await this.getStatus()
    };
  }

  async #readAccountSummary(): Promise<SerializedAccountStatus> {
    try {
      return serializeAccountSummary(await this.options.runtime.readAccountSummary(false));
    } catch (error) {
      return serializeAccountError(error);
    }
  }

  async #readAccountRateLimits(): Promise<SerializedRateLimitsStatus> {
    try {
      return serializeRateLimits(await this.options.runtime.readAccountRateLimits());
    } catch (error) {
      return serializeRateLimitsError(error);
    }
  }

  async #assertSafeToInterrupt(allowActive: boolean, action: string): Promise<void> {
    if (allowActive) {
      return;
    }

    await this.#refreshSessions();
    const activeCount = this.options.sessions.listSessions().filter((session) => Boolean(session.activeTurnId)).length;
    if (activeCount > 0) {
      throw new Error(
        `Refusing ${action} while active sessions exist (activeCount=${activeCount}). Retry with allow_active=true if you really want to interrupt them.`
      );
    }
  }

  async #refreshSessions(): Promise<void> {
    const load = (this.options.sessions as { readonly load?: (() => Promise<void>) | undefined }).load;
    if (typeof load === "function") {
      await load.call(this.options.sessions);
    }
  }

  async #fileInfo(filePath: string): Promise<FileInfo> {
    try {
      const stat = await fs.stat(filePath);
      return {
        exists: true,
        path: summarizeAdminPath(filePath),
        size: stat.size,
        mtime: stat.mtime.toISOString()
      };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return {
          exists: false,
          path: summarizeAdminPath(filePath)
        };
      }

      throw error;
    }
  }

  async #readRecentBrokerLogs(limit: number): Promise<readonly unknown[]> {
    const filePath = path.join(this.options.config.logDir, "broker.jsonl");

    try {
      const raw = await fs.readFile(filePath, "utf8");
      const records: Record<string, unknown>[] = [];
      const lines = raw
        .trim()
        .split("\n")
        .filter(Boolean);

      for (let index = lines.length - 1; index >= 0 && records.length < limit; index -= 1) {
        const line = lines[index]!;
        const record = (() => {
          try {
            return sanitizeAdminBrokerLogRecord(JSON.parse(line) as unknown);
          } catch {
            return {
              type: "log_parse_error",
              message: "unparseable broker log line"
            };
          }
        })();

        if (isMeaningfulAdminBrokerLogRecord(record)) {
          records.push(record);
        }
      }

      return records.reverse();
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  #summarizePlatforms(recentBrokerLogs: readonly unknown[]): Record<"slack" | "feishu", PlatformHealthStatus> {
    const slackLogs = summarizePlatformLogRecords("slack", recentBrokerLogs);
    const feishuLogs = summarizePlatformLogRecords("feishu", recentBrokerLogs);
    const configuredSlackState: PlatformHealthState = slackLogs.lastStartingAt && !slackLogs.lastReadyAt
      ? "starting"
      : "ready";
    const slackState = resolveLogAwarePlatformState(configuredSlackState, slackLogs);
    const configuredFeishuState: PlatformHealthState = !this.options.config.feishuEnabled
      ? "disabled"
      : this.options.config.feishuGroupMessageMode === "at_only"
        ? "degraded"
        : !this.options.config.feishuAllMessageDeliveryVerified
          ? "degraded"
          : "ready";
    const feishuState = resolveLogAwarePlatformState(configuredFeishuState, feishuLogs);
    const groupMessagePermissionStatus =
      !this.options.config.feishuEnabled
        ? "unknown"
        : this.options.config.feishuGroupMessageMode === "all"
          ? this.options.config.feishuAllMessageDeliveryVerified
            ? "verified"
            : "configured"
          : "missing";
    const feishuBotIdentityConfigured = Boolean(
      this.options.config.feishuBotOpenId ||
        this.options.config.feishuBotUserId ||
        this.options.config.feishuBotUnionId
    );
    const feishuConnectionConnected = this.options.config.feishuEnabled &&
      Boolean(feishuLogs.lastReadyAt) &&
      isAfter(feishuLogs.lastReadyAt, feishuLogs.lastDisconnectedAt) &&
      feishuState !== "failed" &&
      feishuState !== "starting";
    const slackConnectionConnected = slackState === "ready" &&
      Boolean(slackLogs.lastReadyAt) &&
      isAfter(slackLogs.lastReadyAt, slackLogs.lastDisconnectedAt);

    return {
      slack: {
        platform: "slack",
        enabled: true,
        state: slackState,
        startupRequired: true,
        connection: {
          mode: "socket_mode",
          connected: slackConnectionConnected,
          lastConnectedAt: slackLogs.lastReadyAt,
          lastDisconnectedAt: slackLogs.lastDisconnectedAt
        },
        lastEvent: slackLogs.lastEvent,
        lastError: slackLogs.lastError
      },
      feishu: {
        platform: "feishu",
        enabled: this.options.config.feishuEnabled,
        state: feishuState,
        startupRequired: this.options.config.feishuStartupRequired,
        groupMessageMode: this.options.config.feishuGroupMessageMode,
        allMessageDeliveryVerified: this.options.config.feishuAllMessageDeliveryVerified,
        connection: {
          mode: "long_connection",
          connected: feishuConnectionConnected,
          lastConnectedAt: feishuLogs.lastReadyAt,
          lastDisconnectedAt: feishuLogs.lastDisconnectedAt
        },
        permissions: [
          {
            name: "im:message.group_at_msg:readonly",
            requiredFor: "Feishu group @bot session creation",
            status: this.options.config.feishuEnabled ? "configured" : "unknown"
          },
          {
            name: "bot_identity",
            requiredFor: "Feishu @bot mention detection",
            status: !this.options.config.feishuEnabled
              ? "unknown"
              : feishuBotIdentityConfigured
                ? "configured"
                : "missing"
          },
          {
            name: "im:message.group_msg",
            requiredFor: "Feishu active-session non-@ follow-ups and group history",
            status: groupMessagePermissionStatus
          },
          {
            name: "im:message:send_as_bot",
            requiredFor: "Feishu text, rich text, and card replies",
            status: this.options.config.feishuEnabled ? "configured" : "unknown"
          }
        ],
        degradedReason:
          feishuState === "failed"
            ? feishuLogs.lastDegraded?.reason ?? "startup_failed"
            : this.options.config.feishuEnabled && this.options.config.feishuGroupMessageMode === "at_only"
              ? "group_message_all_unavailable"
              : this.options.config.feishuEnabled && !this.options.config.feishuAllMessageDeliveryVerified
                ? "all_message_delivery_unverified"
                : undefined,
        lastEvent: feishuLogs.lastEvent,
        lastError: feishuLogs.lastError
      }
    };
  }

  #summarizeInbound(message: PersistedInboundMessage): Record<string, unknown> {
    return {
      sessionKey: message.sessionKey,
      messageTs: message.messageTs,
      source: message.source,
      status: message.status,
      userId: message.userId,
      textPreview: redactInboundTextPreview(message.text),
      textLength: message.text.length,
      textRedacted: true,
      updatedAt: message.updatedAt,
      batchId: message.batchId ?? null
    };
  }

  #summarizeJob(job: PersistedBackgroundJob): Record<string, unknown> {
    const error = job.error ?? undefined;
    return {
      id: job.id,
      sessionKey: job.sessionKey,
      platform: job.platform ?? "slack",
      conversationId: job.conversationId ?? job.channelId,
      rootMessageId: job.rootMessageId ?? job.rootThreadTs,
      kind: job.kind,
      status: job.status,
      cwd: summarizeAdminPath(job.cwd),
      cwdBasename: summarizeAdminPathBasename(job.cwd),
      updatedAt: job.updatedAt,
      heartbeatAt: job.heartbeatAt ?? null,
      lastEventAt: job.lastEventAt ?? null,
      errorLength: error ? error.length : undefined,
      errorRedacted: error ? true : undefined
    };
  }

  #summarizeActiveSession(session: SlackSessionRecord): Record<string, unknown> {
    return {
      key: session.key,
      platform: platformForSession(session),
      conversationId: session.conversationId ?? session.channelId,
      conversationKind: session.conversationKind ?? "channel",
      rootMessageId: session.rootMessageId ?? session.rootThreadTs,
      platformThreadId: session.platformThreadId ?? null,
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      workspacePath: summarizeAdminPath(session.workspacePath),
      workspacePathBasename: summarizeAdminPathBasename(session.workspacePath),
      updatedAt: session.updatedAt,
      createdAt: session.createdAt,
      activeTurnId: session.activeTurnId ?? null,
      activeTurnStartedAt: session.activeTurnStartedAt ?? null,
      lastSlackReplyAt: session.lastSlackReplyAt ?? null,
      lastObservedMessageTs: session.lastObservedMessageTs ?? null,
      lastDeliveredMessageTs: session.lastDeliveredMessageTs ?? null
    };
  }

  #summarizeSession(
    session: SlackSessionRecord,
    related: {
      readonly inbound: readonly PersistedInboundMessage[];
      readonly jobs: readonly PersistedBackgroundJob[];
    }
  ): Record<string, unknown> {
    const runningBackgroundJobCount = related.jobs.filter((job) => job.status === "running").length;
    const failedBackgroundJobCount = related.jobs.filter((job) => job.status === "failed").length;
    return {
      key: session.key,
      platform: platformForSession(session),
      conversationId: session.conversationId ?? session.channelId,
      conversationKind: session.conversationKind ?? "channel",
      rootMessageId: session.rootMessageId ?? session.rootThreadTs,
      platformThreadId: session.platformThreadId ?? null,
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      workspacePath: summarizeAdminPath(session.workspacePath),
      workspacePathBasename: summarizeAdminPathBasename(session.workspacePath),
      updatedAt: session.updatedAt,
      createdAt: session.createdAt,
      activeTurnId: session.activeTurnId ?? null,
      lastSlackReplyAt: session.lastSlackReplyAt ?? null,
      lastObservedMessageTs: session.lastObservedMessageTs ?? null,
      lastDeliveredMessageTs: session.lastDeliveredMessageTs ?? null,
      openInboundCount: related.inbound.length,
      openInbound: related.inbound.slice(0, 5).map((message) => this.#summarizeInbound(message)),
      backgroundJobCount: related.jobs.length,
      runningBackgroundJobCount,
      failedBackgroundJobCount,
      backgroundJobs: related.jobs.slice(0, 5).map((job) => this.#summarizeJob(job))
    };
  }
}

function isMeaningfulAdminBrokerLogRecord(record: Record<string, unknown>): boolean {
  return Boolean(record.message) || Boolean(record.meta) || record.type === "log_parse_error";
}

function compareSessions(left: SlackSessionRecord, right: SlackSessionRecord): number {
  const leftActive = left.activeTurnId ? 1 : 0;
  const rightActive = right.activeTurnId ? 1 : 0;
  if (leftActive !== rightActive) {
    return rightActive - leftActive;
  }
  return String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""));
}

function platformForSession(session: SlackSessionRecord): ChatPlatform {
  return session.platform ?? "slack";
}

function groupBySession<T extends { readonly sessionKey: string }>(items: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const existing = groups.get(item.sessionKey);
    if (existing) {
      existing.push(item);
      continue;
    }
    groups.set(item.sessionKey, [item]);
  }
  return groups;
}

function summarizeAuthProfilesStatus(status: AuthProfilesStatus): AuthProfilesStatus {
  return {
    ...status,
    managedRoot: summarizeAdminPath(status.managedRoot),
    profilesRoot: summarizeAdminPath(status.profilesRoot),
    activeAuthPath: summarizeAdminPath(status.activeAuthPath),
    profiles: status.profiles.map(summarizeAuthProfileSummary)
  };
}

function summarizeAuthProfileSummary(profile: AuthProfileSummary): AuthProfileSummary {
  return {
    ...profile,
    path: summarizeAdminPath(profile.path)
  };
}

function summarizeDeploymentStatus(status: WorkerDeploymentStatus): WorkerDeploymentStatus {
  return {
    ...status,
    serviceRoot: summarizeAdminPath(status.serviceRoot),
    repoRoot: summarizeAdminPath(status.repoRoot),
    currentRelease: summarizeWorkerRelease(status.currentRelease),
    previousRelease: summarizeWorkerRelease(status.previousRelease),
    failedRelease: summarizeWorkerRelease(status.failedRelease),
    recentReleases: status.recentReleases.map(summarizeWorkerRelease)
  };
}

function summarizeWorkerRelease(release: WorkerReleaseInfo): WorkerReleaseInfo {
  return {
    ...release,
    linkPath: summarizeAdminPath(release.linkPath),
    targetPath: release.targetPath ? summarizeAdminPath(release.targetPath) : null
  };
}

function summarizeAdminPath(filePath: string): string;
function summarizeAdminPath(filePath: string | undefined): string | undefined;
function summarizeAdminPath(filePath: string | undefined): string | undefined {
  const basename = summarizeAdminPathBasename(filePath);
  return basename ? `${basename} (path redacted)` : undefined;
}

function summarizeAdminPathBasename(filePath: string | undefined): string | undefined {
  const text = readString(filePath);
  if (!text) {
    return undefined;
  }

  const basename = path.basename(text);
  if (
    !basename ||
    basename === "." ||
    SECRET_LIKE_ADMIN_LOG_META_VALUE.test(basename) ||
    SENTINEL_LIKE_ADMIN_PATH_VALUE.test(basename)
  ) {
    return "[redacted-path]";
  }

  return basename;
}

function summarizePlatformLogRecords(
  platform: "slack" | "feishu",
  records: readonly unknown[]
): PlatformLogSnapshot {
  let lastReadyAt: string | undefined;
  let lastStartingAt: string | undefined;
  let lastDisconnectedAt: string | undefined;
  let lastDegraded: PlatformLogSnapshot["lastDegraded"] | undefined;
  let lastStartupFailureAt: string | undefined;
  let lastEvent: PlatformLogSnapshot["lastEvent"] | undefined;
  let lastError: PlatformLogSnapshot["lastError"] | undefined;

  for (const record of records) {
    const log = asLogRecord(record);
    const meta = asRecord(log?.meta);
    if (!log || meta?.platform !== platform) {
      continue;
    }

    switch (log.message) {
      case "chat.platform.starting":
        lastStartingAt = log.ts;
        break;
      case "chat.platform.ready":
        lastReadyAt = log.ts;
        break;
      case "chat.platform.degraded": {
        const reason = readString(meta.degradedReason);
        lastDegraded = {
          at: log.ts,
          reason
        };
        if (reason === "startup_failed") {
          lastStartupFailureAt = log.ts;
        }
        if (isConnectionDegradation(reason)) {
          lastDisconnectedAt = log.ts;
        }
        lastError = {
          at: log.ts,
          errorClass: readString(meta.errorClass) ?? "PlatformDegraded",
          message: reason ? `${log.message}: ${reason}` : log.message
        };
        break;
      }
      case "chat.message.accepted":
        lastEvent = {
          eventId: readString(meta.eventId),
          messageId: readString(meta.messageId),
          receivedAt: log.ts
        };
        break;
      case "chat.outbound.failed":
        lastError = {
          at: log.ts,
          errorClass: readString(meta.errorClass) ?? "PlatformSendFailed",
          message: readScalarText(meta.statusCode) ? `${log.message}: ${readScalarText(meta.statusCode)}` : log.message
        };
        break;
    }
  }

  return {
    lastReadyAt,
    lastStartingAt,
    lastDisconnectedAt,
    lastDegraded,
    lastStartupFailureAt,
    lastEvent,
    lastError
  };
}

function sanitizeAdminBrokerLogRecord(record: unknown): Record<string, unknown> {
  const parsed = asRecord(record);
  if (!parsed) {
    return {
      type: "log_parse_error",
      message: "non-object broker log line"
    };
  }

  const sanitizedMeta = sanitizeAdminLogMeta(asRecord(parsed.meta));
  return withoutUndefined({
    ts: readSafeAdminLogTimestamp(parsed.ts),
    type: readSafeAdminLogToken(parsed.type),
    level: readSafeAdminLogToken(parsed.level),
    message: readSafeAdminLogToken(parsed.message),
    meta: sanitizedMeta ? sanitizedMeta : undefined
  });
}

function sanitizeAdminLogMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) {
    return undefined;
  }

  const safeEntries = Object.entries(meta).filter(([key, value]) =>
    ADMIN_SAFE_LOG_META_FIELDS.has(key) && isSafeAdminLogMetaValue(value)
  );
  return safeEntries.length > 0 ? Object.fromEntries(safeEntries) : undefined;
}

function isSafeAdminLogMetaValue(value: unknown): boolean {
  if (typeof value === "string") {
    return !SECRET_LIKE_ADMIN_LOG_META_VALUE.test(value);
  }

  return typeof value === "number" || typeof value === "boolean" || value === null;
}

function readSafeAdminLogToken(value: unknown): string | undefined {
  const text = readString(value);
  return text && SAFE_ADMIN_LOG_TOKEN.test(text) ? text : undefined;
}

function readSafeAdminLogTimestamp(value: unknown): string | undefined {
  const text = readString(value);
  return text && SAFE_ADMIN_LOG_TIMESTAMP.test(text) ? text : undefined;
}

function withoutUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined)
  );
}

function isConnectionDegradation(reason: string | undefined): boolean {
  return reason === "connection_closed" || reason === "connection_failed";
}

function resolveLogAwarePlatformState(
  configuredState: PlatformHealthState,
  snapshot: PlatformLogSnapshot
): PlatformHealthState {
  if (configuredState === "disabled") {
    return "disabled";
  }

  if (isAfter(snapshot.lastStartupFailureAt, snapshot.lastReadyAt)) {
    return "failed";
  }

  if (
    isAfter(snapshot.lastStartingAt, snapshot.lastReadyAt) &&
    isAfter(snapshot.lastStartingAt, snapshot.lastDegraded?.at)
  ) {
    return "starting";
  }

  if (configuredState === "ready" && isAfter(snapshot.lastDegraded?.at, snapshot.lastReadyAt)) {
    return "degraded";
  }

  return configuredState;
}

function asLogRecord(value: unknown): {
  readonly ts: string;
  readonly type: string;
  readonly message: string;
  readonly meta?: unknown;
} | undefined {
  const record = asRecord(value);
  const ts = readString(record?.ts);
  const type = readString(record?.type);
  const message = readString(record?.message);
  if (!record || !ts || type !== "log" || !message) {
    return undefined;
  }

  return {
    ts,
    type,
    message,
    meta: record.meta
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readScalarText(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function redactInboundTextPreview(text: string): string {
  return `message body redacted (${text.length} chars)`;
}

function isAfter(left: string | undefined, right: string | undefined): boolean {
  if (!left) {
    return false;
  }
  if (!right) {
    return true;
  }
  return left > right;
}
