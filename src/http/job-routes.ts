import http from "node:http";
import { URL } from "node:url";

import type { JobManager } from "../services/job-manager.js";
import { logger } from "../logger.js";
import {
  parseJsonLikeRequestField,
  readBoolean,
  readJsonBody,
  readString,
  respondJson
} from "./common.js";
import { redactHttpRequestBody } from "./request-log-redaction.js";
import { CHAT_PLATFORM_VALUES, type ChatPlatform } from "../services/chat/chat-types.js";

const CHAT_JOB_COORDINATE_REQUIRED_FIELDS = [
  "platform",
  "conversationId (alias: conversation_id)",
  "rootMessageId (alias: root_message_id)"
];

export async function handleJobRequest(
  method: string,
  url: URL,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: {
    readonly jobManager: JobManager;
  }
): Promise<boolean> {
  if (method === "POST" && url.pathname === "/jobs/register") {
    await handleJobRegisterRequest(request, response, options);
    return true;
  }

  const matchedJobAction = matchJobAction(url.pathname);
  if (method === "POST" && matchedJobAction) {
    await handleJobActionRequest(request, response, options, matchedJobAction);
    return true;
  }

  return false;
}

async function handleJobRegisterRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: {
    readonly jobManager: JobManager;
  }
): Promise<void> {
  let body: Record<string, unknown>;

  try {
    body = await readJsonBody(request);
  } catch (error) {
    respondJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }
  logger.raw("http-requests", {
    method: "POST",
    path: "/jobs/register",
    body: redactHttpRequestBody(body)
  }, {
    channelId: readString(body.channel_id),
    rootThreadTs: readString(body.thread_ts),
    platform: readPlatform(body.platform),
    conversationId: readString(body.conversation_id) ?? readString(body.conversationId),
    rootMessageId: readString(body.root_message_id) ?? readString(body.rootMessageId)
  });

  const platform = readPlatform(body.platform);
  const conversationId = readString(body.conversation_id) ?? readString(body.conversationId);
  const rootMessageId = readString(body.root_message_id) ?? readString(body.rootMessageId);
  const channelId = readString(body.channel_id);
  const rootThreadTs = readString(body.thread_ts);
  const kind = readString(body.kind);
  const script = readString(body.script);
  const hasGenericCoordinates = Boolean(platform && conversationId && rootMessageId);
  const acceptsLegacySlackCoordinates = !body.platform || platform === "slack";
  const hasLegacySlackCoordinates = acceptsLegacySlackCoordinates && Boolean(channelId && rootThreadTs);

  if (isInvalidPlatformValue(body.platform)) {
    respondJson(response, 400, {
      ok: false,
      error: "invalid_platform",
      allowed: CHAT_PLATFORM_VALUES
    });
    return;
  }

  if ((!hasGenericCoordinates && !hasLegacySlackCoordinates) || !kind || !script) {
    respondJson(response, 400, {
      ok: false,
      error: "missing_required_body",
      required: [...CHAT_JOB_COORDINATE_REQUIRED_FIELDS, "kind", "script"],
      legacyAliases: ["channel_id", "thread_ts"]
    });
    return;
  }

  try {
    const job = await options.jobManager.registerJob({
      platform,
      conversationId,
      rootMessageId,
      channelId,
      rootThreadTs,
      kind,
      script,
      cwd: readString(body.cwd) || undefined,
      shell: readString(body.shell) || undefined,
      restartOnBoot: readBoolean(body.restart_on_boot, true)
    });
    respondJson(response, 200, {
      ok: true,
      job: {
        id: job.id,
        token: job.token,
        status: job.status,
        kind: job.kind,
        cwd: job.cwd,
        shell: job.shell,
        scriptPath: job.scriptPath,
        restartOnBoot: job.restartOnBoot,
        platform: job.platform,
        conversationId: job.conversationId,
        rootMessageId: job.rootMessageId,
        channelId: job.channelId,
        rootThreadTs: job.rootThreadTs,
        createdAt: job.createdAt
      }
    });
  } catch (error) {
    respondJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function handleJobActionRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: {
    readonly jobManager: JobManager;
  },
  action: {
    readonly jobId: string;
    readonly action: "heartbeat" | "event" | "complete" | "fail" | "cancel";
  }
): Promise<void> {
  let body: Record<string, unknown>;

  try {
    body = await readJsonBody(request);
  } catch (error) {
    respondJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }
  logger.raw("http-requests", {
    method: "POST",
    path: `/jobs/${action.jobId}/${action.action}`,
    body: redactHttpRequestBody(body)
  }, {
    jobId: action.jobId
  });

  const token = readString(body.token);

  try {
    let job;

    switch (action.action) {
      case "heartbeat":
        if (!token) {
          throw new Error("missing_job_token");
        }
        job = await options.jobManager.heartbeatJob(action.jobId, token);
        break;
      case "event":
        if (!token) {
          throw new Error("missing_job_token");
        }
        if (!readString(body.event_kind) || !readString(body.summary)) {
          throw new Error("missing_required_body:event_kind,summary");
        }
        {
          const detailsJsonResult = parseJsonLikeRequestField(
            body.details_json ?? body.detailsJson,
            "detailsJson (alias: details_json)"
          );
          if (!detailsJsonResult.ok) {
            respondJson(response, 400, {
              ok: false,
              error: "invalid_json_field",
              field: detailsJsonResult.field
            });
            return;
          }

          job = await options.jobManager.emitJobEvent(action.jobId, token, {
            eventKind: readString(body.event_kind)!,
            summary: readString(body.summary)!,
            detailsText: readString(body.details_text) || undefined,
            detailsJson: detailsJsonResult.value
          });
        }
        break;
      case "complete":
        if (!token) {
          throw new Error("missing_job_token");
        }
        {
          const detailsJsonResult = parseJsonLikeRequestField(
            body.details_json ?? body.detailsJson,
            "detailsJson (alias: details_json)"
          );
          if (!detailsJsonResult.ok) {
            respondJson(response, 400, {
              ok: false,
              error: "invalid_json_field",
              field: detailsJsonResult.field
            });
            return;
          }

          job = await options.jobManager.completeJob(action.jobId, token, {
            summary: readString(body.summary) || undefined,
            detailsText: readString(body.details_text) || undefined,
            detailsJson: detailsJsonResult.value
          });
        }
        break;
      case "fail":
        if (!token) {
          throw new Error("missing_job_token");
        }
        {
          const detailsJsonResult = parseJsonLikeRequestField(
            body.details_json ?? body.detailsJson,
            "detailsJson (alias: details_json)"
          );
          if (!detailsJsonResult.ok) {
            respondJson(response, 400, {
              ok: false,
              error: "invalid_json_field",
              field: detailsJsonResult.field
            });
            return;
          }

          job = await options.jobManager.failJob(action.jobId, token, {
            summary: readString(body.summary) || undefined,
            error: readString(body.error) || undefined,
            detailsText: readString(body.details_text) || undefined,
            detailsJson: detailsJsonResult.value
          });
        }
        break;
      case "cancel":
        if (!token) {
          throw new Error("missing_job_token");
        }
        job = await options.jobManager.cancelJob(action.jobId, token);
        break;
    }

    respondJson(response, 200, {
      ok: true,
      job
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    respondJson(response, message.startsWith("missing_") || message === "invalid_job_token" ? 400 : 500, {
      ok: false,
      error: message
    });
  }
}

function readPlatform(value: unknown): ChatPlatform | undefined {
  return value === "slack" || value === "feishu" ? value : undefined;
}

function isInvalidPlatformValue(value: unknown): boolean {
  return value != null && value !== "" && !readPlatform(value);
}

function matchJobAction(pathname: string): {
  readonly jobId: string;
  readonly action: "heartbeat" | "event" | "complete" | "fail" | "cancel";
} | null {
  const match = pathname.match(/^\/jobs\/([^/]+)\/(heartbeat|event|complete|fail|cancel)$/);
  if (!match) {
    return null;
  }

  const [, jobId, action] = match;
  if (!jobId || !action) {
    return null;
  }

  return {
    jobId,
    action: action as "heartbeat" | "event" | "complete" | "fail" | "cancel"
  };
}
