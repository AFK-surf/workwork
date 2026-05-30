// -nocheck
import http from "node:http";

import { URL } from "node:url";

import type { AppConfig } from "../config.js";

import { logger } from "../logger.js";

import type { SlackAgentBridge } from "../services/slack/slack-agent-bridge.js";

import { readBoolean, readJsonBody, readFormBody, readString, respondJson } from "./common.js";
import {
  handleSlackPostFileRequest,
  handleResolveCommitCoauthorsRequest,
  handleResolveGitHubTokenRequest,
  handleGetCommitCoauthorStatusRequest,
  handleConfigureCommitCoauthorsRequest,
  normalizeStringArray,
  matchResumeSessionPath,
  matchResetSessionPath,
  matchDeleteSessionPath,
  normalizeMappings,
} from "./slack-routes-helpers-2.js";

export const LEGACY_COAUTHOR_MAPPING_ERROR = "Manual co-author mappings are no longer supported. Bind GitHub OAuth for Slack users instead.";

export async function handleSlackResumePendingSessionRequest(
  response: http.ServerResponse,
  options: {
    readonly bridge: SlackAgentBridge;
  },
  sessionKey: string,
): Promise<void> {
  try {
    const resumedCount = await options.bridge.resumePendingSession(sessionKey);
    respondJson(response, 200, {
      ok: true,
      sessionKey,
      resumedCount,
    });
  } catch (error) {
    respondJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleSlackResetSessionRequest(
  response: http.ServerResponse,
  options: {
    readonly bridge: SlackAgentBridge;
  },
  sessionKey: string,
): Promise<void> {
  try {
    const reset = await options.bridge.resetSession(sessionKey);
    respondJson(response, 200, {
      ok: true,
      sessionKey,
      reset,
    });
  } catch (error) {
    respondJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleSlackDeleteSessionRequest(
  response: http.ServerResponse,
  options: {
    readonly bridge: SlackAgentBridge;
  },
  sessionKey: string,
): Promise<void> {
  try {
    const deleted = await options.bridge.deleteSession(sessionKey);
    respondJson(response, 200, {
      ok: true,
      sessionKey,
      delete: deleted,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    respondJson(response, message.includes("Unknown session") ? 404 : 500, {
      ok: false,
      error: message,
    });
  }
}

export async function handleSlackThreadHistoryRequest(
  url: URL,
  response: http.ServerResponse,
  options: {
    readonly bridge: SlackAgentBridge;
    readonly config: AppConfig;
  },
): Promise<void> {
  const channelId = url.searchParams.get("channel_id");
  const rootThreadTs = url.searchParams.get("thread_ts");

  if (!channelId || !rootThreadTs) {
    respondJson(response, 400, {
      ok: false,
      error: "missing_required_query",
      required: ["channel_id", "thread_ts"],
    });
    return;
  }

  const limitParam = url.searchParams.get("limit");
  const parsedLimit = limitParam == null ? undefined : Number(limitParam);

  if (limitParam != null && !Number.isFinite(parsedLimit)) {
    respondJson(response, 400, { ok: false, error: "invalid_limit" });
    return;
  }

  try {
    const result = await options.bridge.readThreadHistory({
      channelId,
      rootThreadTs,
      beforeMessageTs: url.searchParams.get("before_ts") ?? undefined,
      channelType: url.searchParams.get("channel_type") ?? undefined,
      limit: parsedLimit,
    });
    const responseFormat = url.searchParams.get("format") ?? "json";

    if (responseFormat === "text") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(result.formattedText ?? "No earlier Slack thread history matched the request.");
      return;
    }

    respondJson(response, 200, {
      ok: true,
      channelId,
      rootThreadTs,
      beforeMessageTs: url.searchParams.get("before_ts") ?? undefined,
      returnedCount: result.messages.length,
      hasMore: result.hasMore,
      maxLimit: options.config.slackHistoryApiMaxLimit,
      formattedText: result.formattedText,
      messages: result.messages,
    });
  } catch (error) {
    respondJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleSlackReplayThreadMessageRequest(
  url: URL,
  response: http.ServerResponse,
  options: {
    readonly bridge: SlackAgentBridge;
  },
): Promise<void> {
  const channelId = url.searchParams.get("channel_id");
  const rootThreadTs = url.searchParams.get("thread_ts");
  const messageTs = url.searchParams.get("message_ts");

  if (!channelId || !rootThreadTs || !messageTs) {
    respondJson(response, 400, {
      ok: false,
      error: "missing_required_query",
      required: ["channel_id", "thread_ts", "message_ts"],
    });
    return;
  }

  try {
    const replayed = await options.bridge.replayThreadMessage({
      channelId,
      rootThreadTs,
      messageTs,
    });

    if (!replayed) {
      respondJson(response, 404, {
        ok: false,
        error: "message_not_replayed",
      });
      return;
    }

    respondJson(response, 200, {
      ok: true,
      replayed,
    });
  } catch (error) {
    respondJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleSlackPostMessageRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: {
    readonly bridge: SlackAgentBridge;
  },
): Promise<void> {
  let body: Record<string, string>;

  try {
    body = await readFormBody(request);
  } catch (error) {
    respondJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  logger.raw(
    "http-requests",
    {
      method: "POST",
      path: "/slack/post-message",
      body,
    },
    {
      channelId: body.channel_id,
      rootThreadTs: body.thread_ts,
    },
  );

  const channelId = body.channel_id;
  const rootThreadTs = body.thread_ts;
  const text = body.text?.trim();
  const kind = body.kind?.trim();
  const reason = body.reason?.trim() || body.stop_reason?.trim() || undefined;

  if (!channelId || !rootThreadTs || !text) {
    respondJson(response, 400, {
      ok: false,
      error: "missing_required_body",
      required: ["channel_id", "thread_ts", "text"],
    });
    return;
  }

  if (kind && !["progress", "final", "block", "wait"].includes(kind)) {
    respondJson(response, 400, {
      ok: false,
      error: "invalid_kind",
      allowed: ["progress", "final", "block", "wait"],
    });
    return;
  }

  if ((kind === "block" || kind === "wait") && !reason) {
    respondJson(response, 400, {
      ok: false,
      error: "missing_reason",
      required: ["reason"],
    });
    return;
  }

  try {
    await options.bridge.postSlackMessage({
      channelId,
      rootThreadTs,
      text,
      kind: kind as "progress" | "final" | "block" | "wait" | undefined,
      reason,
    });
    respondJson(response, 200, { ok: true });
  } catch (error) {
    respondJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleSlackPostStateRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: {
    readonly bridge: SlackAgentBridge;
  },
): Promise<void> {
  let body: Record<string, string>;

  try {
    body = await readFormBody(request);
  } catch (error) {
    respondJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  logger.raw(
    "http-requests",
    {
      method: "POST",
      path: "/slack/post-state",
      body,
    },
    {
      channelId: body.channel_id,
      rootThreadTs: body.thread_ts,
    },
  );

  const channelId = body.channel_id;
  const rootThreadTs = body.thread_ts;
  const kind = body.kind?.trim();
  const reason = body.reason?.trim() || body.stop_reason?.trim() || undefined;

  if (!channelId || !rootThreadTs || !kind) {
    respondJson(response, 400, {
      ok: false,
      error: "missing_required_body",
      required: ["channel_id", "thread_ts", "kind"],
    });
    return;
  }

  if (kind !== "wait" && kind !== "block" && kind !== "final") {
    respondJson(response, 400, {
      ok: false,
      error: "invalid_kind",
      allowed: ["wait", "block", "final"],
    });
    return;
  }

  if ((kind === "wait" || kind === "block") && !reason) {
    respondJson(response, 400, {
      ok: false,
      error: "missing_reason",
      required: ["reason"],
    });
    return;
  }

  try {
    await options.bridge.postSlackState({
      channelId,
      rootThreadTs,
      kind: kind as "wait" | "block" | "final",
      reason,
    });
    respondJson(response, 200, { ok: true });
  } catch (error) {
    respondJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
