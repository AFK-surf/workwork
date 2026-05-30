// -nocheck
import http from "node:http";

import { URL } from "node:url";

import type { AppConfig } from "../config.js";

import { logger } from "../logger.js";

import type { SlackAgentBridge } from "../services/slack/slack-agent-bridge.js";

import { readBoolean, readJsonBody, readFormBody, readString, respondJson } from "./common.js";
import { LEGACY_COAUTHOR_MAPPING_ERROR, handleSlackResumePendingSessionRequest, handleSlackResetSessionRequest, handleSlackDeleteSessionRequest, handleSlackThreadHistoryRequest, handleSlackReplayThreadMessageRequest, handleSlackPostMessageRequest, handleSlackPostStateRequest } from "./slack-routes-helpers-1.js";

export async function handleSlackPostFileRequest(
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
      path: "/slack/post-file",
      body: {
        ...body,
        content_base64: body.content_base64 ? `[base64:${body.content_base64.length}]` : undefined,
      },
    },
    {
      channelId: body.channel_id,
      rootThreadTs: body.thread_ts,
    },
  );

  const channelId = body.channel_id;
  const rootThreadTs = body.thread_ts;
  const filePath = body.file_path?.trim() || undefined;
  const contentBase64 = body.content_base64?.trim() || undefined;
  const filename = body.filename?.trim() || undefined;
  const initialComment = (body.initial_comment ?? body.text)?.trim() || undefined;

  if (!channelId || !rootThreadTs || (!filePath && !contentBase64)) {
    respondJson(response, 400, {
      ok: false,
      error: "missing_required_body",
      required: ["channel_id", "thread_ts", "file_path|content_base64"],
    });
    return;
  }

  try {
    const uploaded = await options.bridge.postSlackFile({
      channelId,
      rootThreadTs,
      filePath,
      contentBase64,
      filename,
      title: body.title?.trim() || undefined,
      initialComment,
      altText: body.alt_text?.trim() || undefined,
      snippetType: body.snippet_type?.trim() || undefined,
      contentType: body.content_type?.trim() || undefined,
    });
    respondJson(response, 200, {
      ok: true,
      file: uploaded,
    });
  } catch (error) {
    respondJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleResolveCommitCoauthorsRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: {
    readonly bridge: SlackAgentBridge;
  },
): Promise<void> {
  try {
    const body = await readJsonBody(request);
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const commitMessage = typeof body.commit_message === "string" ? body.commit_message : "";
    const primaryAuthorEmail = typeof body.primary_author_email === "string" ? body.primary_author_email.trim() : undefined;

    if (!cwd || !commitMessage) {
      respondJson(response, 400, {
        ok: false,
        error: "missing_required_body",
        required: ["cwd", "commit_message"],
      });
      return;
    }

    const result = await options.bridge.resolveCommitCoauthors({
      cwd,
      commitMessage,
      primaryAuthorEmail,
    });

    respondJson(response, 200, {
      ok: true,
      ...result,
    });
  } catch (error) {
    respondJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleResolveGitHubTokenRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: {
    readonly bridge: SlackAgentBridge;
  },
): Promise<void> {
  try {
    const body = await readJsonBody(request);
    const cwd = readString(body.cwd);
    const command = normalizeStringArray(body.command) ?? [];
    if (!cwd) {
      respondJson(response, 400, {
        ok: false,
        error: "missing_required_body",
        required: ["cwd"],
      });
      return;
    }

    const result = await options.bridge.resolveGitHubPrToken({
      cwd,
      command,
    });
    respondJson(response, result.ok ? 200 : 409, result);
  } catch (error) {
    respondJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleGetCommitCoauthorStatusRequest(
  url: URL,
  response: http.ServerResponse,
  options: {
    readonly bridge: SlackAgentBridge;
  },
): Promise<void> {
  const cwd = url.searchParams.get("cwd")?.trim();
  if (!cwd) {
    respondJson(response, 400, {
      ok: false,
      error: "missing_required_query",
      required: ["cwd"],
    });
    return;
  }

  try {
    const status = await options.bridge.getCommitCoauthorStatus(cwd);
    if (!status) {
      respondJson(response, 404, {
        ok: false,
        error: "session_not_found",
      });
      return;
    }

    respondJson(response, 200, {
      ok: true,
      status,
    });
  } catch (error) {
    respondJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleConfigureCommitCoauthorsRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: {
    readonly bridge: SlackAgentBridge;
  },
): Promise<void> {
  try {
    const body = await readJsonBody(request);
    const cwd = readString(body.cwd);
    if (!cwd) {
      respondJson(response, 400, {
        ok: false,
        error: "missing_required_body",
        required: ["cwd"],
      });
      return;
    }

    const coauthors = normalizeStringArray(body.coauthors);
    const userIds = normalizeStringArray(body.user_ids);
    const mappings = normalizeMappings(body.mappings);
    if (mappings) {
      respondJson(response, 400, {
        ok: false,
        error: LEGACY_COAUTHOR_MAPPING_ERROR,
      });
      return;
    }
    const ignoreMissing = Object.prototype.hasOwnProperty.call(body, "ignore_missing") || Object.prototype.hasOwnProperty.call(body, "ignoreMissing") ? readBoolean(body.ignore_missing ?? body.ignoreMissing, false) : undefined;
    const status = await options.bridge.configureSessionCoauthors({
      cwd,
      coauthors,
      userIds,
      ignoreMissing,
      mappings,
    });

    if (!status) {
      respondJson(response, 404, {
        ok: false,
        error: "session_not_found",
      });
      return;
    }

    respondJson(response, 200, {
      ok: true,
      status,
    });
  } catch (error) {
    respondJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

export function matchResumeSessionPath(pathname: string): { readonly sessionKey: string } | null {
  const prefix = "/slack/sessions/";
  const suffix = "/resume-pending";
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return null;
  }

  const encodedKey = pathname.slice(prefix.length, -suffix.length);
  if (!encodedKey) {
    return null;
  }

  return {
    sessionKey: decodeURIComponent(encodedKey),
  };
}

export function matchResetSessionPath(pathname: string): { readonly sessionKey: string } | null {
  const prefix = "/slack/sessions/";
  const suffix = "/reset";
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return null;
  }

  const encodedKey = pathname.slice(prefix.length, -suffix.length);
  if (!encodedKey) {
    return null;
  }

  return {
    sessionKey: decodeURIComponent(encodedKey),
  };
}

export function matchDeleteSessionPath(pathname: string): { readonly sessionKey: string } | null {
  const prefix = "/slack/sessions/";
  if (!pathname.startsWith(prefix)) {
    return null;
  }

  const encodedKey = pathname.slice(prefix.length);
  if (!encodedKey || encodedKey.includes("/")) {
    return null;
  }

  return {
    sessionKey: decodeURIComponent(encodedKey),
  };
}

export function normalizeMappings(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const entries = value.filter((entry) => Boolean(entry));
  return entries.length > 0 ? entries : undefined;
}
