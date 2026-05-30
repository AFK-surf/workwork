import http from "node:http";
import { URL } from "node:url";

import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";
import { CHAT_FILE_SOURCE_FIELD_DESCRIPTIONS, CHAT_INLINE_FILE_CONTENT_REQUIREMENT_MESSAGE, CHAT_INLINE_FILE_FILENAME_REQUIREMENT_MESSAGE, CHAT_PLATFORM_VALUES, isNonEmptyBase64Content, type ChatMessageFormat, type ChatPlatform } from "../services/chat/chat-types.js";
import type { SlackAgentBridge } from "../services/slack/slack-agent-bridge.js";
import { parseJsonLikeRequestField, readJsonBody, readPositiveIntegerQueryParam, readString, respondJson } from "./common.js";
import { redactHttpRequestBody } from "./request-log-redaction.js";

const CHAT_COORDINATE_REQUIRED_FIELDS = ["platform", "conversationId (alias: conversation_id)", "rootMessageId (alias: root_message_id)"];

export async function handleChatRequest(
  method: string,
  url: URL,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: {
    readonly bridge: SlackAgentBridge;
    readonly config: AppConfig;
  },
): Promise<boolean> {
  if (method === "GET" && url.pathname === "/chat/thread-history") {
    await handleChatThreadHistoryRequest(url, response, options);
    return true;
  }

  if (method === "POST" && url.pathname === "/chat/post-message") {
    await handleChatPostMessageRequest(request, response, options);
    return true;
  }

  if (method === "POST" && url.pathname === "/chat/post-state") {
    await handleChatPostStateRequest(request, response, options);
    return true;
  }

  if (method === "POST" && url.pathname === "/chat/post-file") {
    await handleChatPostFileRequest(request, response, options);
    return true;
  }

  return false;
}

async function handleChatThreadHistoryRequest(
  url: URL,
  response: http.ServerResponse,
  options: {
    readonly bridge: SlackAgentBridge;
    readonly config: AppConfig;
  },
): Promise<void> {
  const platform = readPlatform(url.searchParams.get("platform"));
  const platformValue = url.searchParams.get("platform");
  const conversationId = url.searchParams.get("conversation_id") ?? url.searchParams.get("conversationId") ?? undefined;
  const rootMessageId = url.searchParams.get("root_message_id") ?? url.searchParams.get("rootMessageId") ?? undefined;
  const limitParam = url.searchParams.get("limit");
  const parsedLimit = readPositiveIntegerQueryParam(limitParam);
  const formatParam = url.searchParams.get("format");
  const responseFormat = readHistoryResponseFormat(formatParam);

  if (isInvalidPlatformValue(platformValue)) {
    respondJson(response, 400, {
      ok: false,
      error: "invalid_platform",
      allowed: CHAT_PLATFORM_VALUES,
    });
    return;
  }

  if (!platform || !conversationId || !rootMessageId) {
    respondJson(response, 400, {
      ok: false,
      error: "missing_required_query",
      required: CHAT_COORDINATE_REQUIRED_FIELDS,
    });
    return;
  }

  if (limitParam != null && parsedLimit == null) {
    respondJson(response, 400, {
      ok: false,
      error: "invalid_limit",
      message: "limit must be a positive integer",
    });
    return;
  }

  if (formatParam != null && !responseFormat) {
    respondJson(response, 400, {
      ok: false,
      error: "invalid_format",
      allowed: ["json", "text"],
    });
    return;
  }

  try {
    const result = await options.bridge.readChatThreadHistory({
      platform,
      conversationId,
      rootMessageId,
      beforeMessageId: url.searchParams.get("before_message_id") ?? url.searchParams.get("beforeMessageId") ?? undefined,
      beforeCursor: url.searchParams.get("before_cursor") ?? url.searchParams.get("beforeCursor") ?? undefined,
      limit: parsedLimit,
    });

    if (responseFormat === "text") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(result.formattedText ?? "No earlier chat history matched the request.");
      return;
    }

    respondJson(response, 200, {
      ok: true,
      platform,
      conversationId,
      rootMessageId,
      returnedCount: result.messages.length,
      hasMore: result.hasMore,
      nextCursor: result.nextCursor,
      maxLimit: platform === "slack" ? options.config.slackHistoryApiMaxLimit : options.config.feishuHistoryApiMaxLimit,
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

async function handleChatPostMessageRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: {
    readonly bridge: SlackAgentBridge;
  },
): Promise<void> {
  let body: Record<string, unknown>;

  try {
    body = await readJsonBody(request);
  } catch (error) {
    respondJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const platform = readPlatform(body.platform);
  const conversationId = readString(body.conversation_id) ?? readString(body.conversationId);
  const rootMessageId = readString(body.root_message_id) ?? readString(body.rootMessageId);
  const text = readString(body.text);
  const kind = readString(body.kind);
  const reason = readString(body.reason) ?? readString(body.stop_reason);
  const format = readMessageFormat(body.format);

  logger.raw(
    "http-requests",
    {
      method: "POST",
      path: "/chat/post-message",
      body: redactHttpRequestBody(body),
    },
    {
      platform,
      conversationId,
      rootMessageId,
    },
  );

  if (!platform || !conversationId || !rootMessageId || !text) {
    if (isInvalidPlatformValue(body.platform)) {
      respondJson(response, 400, {
        ok: false,
        error: "invalid_platform",
        allowed: CHAT_PLATFORM_VALUES,
      });
      return;
    }

    respondJson(response, 400, {
      ok: false,
      error: "missing_required_body",
      required: [...CHAT_COORDINATE_REQUIRED_FIELDS, "text"],
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

  if (body.format != null && !format) {
    respondJson(response, 400, {
      ok: false,
      error: "invalid_format",
      allowed: ["text", "markdown", "rich_text", "card"],
    });
    return;
  }

  const richTextResult = parseJsonLikeRequestField(body.rich_text ?? body.richText, "richText (alias: rich_text)");
  if (!richTextResult.ok) {
    respondJson(response, 400, {
      ok: false,
      error: "invalid_json_field",
      field: richTextResult.field,
    });
    return;
  }

  const cardResult = parseJsonLikeRequestField(body.card, "card");
  if (!cardResult.ok) {
    respondJson(response, 400, {
      ok: false,
      error: "invalid_json_field",
      field: cardResult.field,
    });
    return;
  }

  try {
    await options.bridge.postChatMessage({
      platform,
      conversationId,
      rootMessageId,
      text,
      kind: kind as "progress" | "final" | "block" | "wait" | undefined,
      reason,
      format,
      richText: richTextResult.value,
      card: cardResult.value,
    });
    respondJson(response, 200, { ok: true });
  } catch (error) {
    respondJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleChatPostStateRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: {
    readonly bridge: SlackAgentBridge;
  },
): Promise<void> {
  let body: Record<string, unknown>;

  try {
    body = await readJsonBody(request);
  } catch (error) {
    respondJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const platform = readPlatform(body.platform);
  const conversationId = readString(body.conversation_id) ?? readString(body.conversationId);
  const rootMessageId = readString(body.root_message_id) ?? readString(body.rootMessageId);
  const kind = readString(body.kind);
  const reason = readString(body.reason) ?? readString(body.stop_reason);

  logger.raw(
    "http-requests",
    {
      method: "POST",
      path: "/chat/post-state",
      body: redactHttpRequestBody(body),
    },
    {
      platform,
      conversationId,
      rootMessageId,
    },
  );

  if (!platform || !conversationId || !rootMessageId || !kind) {
    if (isInvalidPlatformValue(body.platform)) {
      respondJson(response, 400, {
        ok: false,
        error: "invalid_platform",
        allowed: CHAT_PLATFORM_VALUES,
      });
      return;
    }

    respondJson(response, 400, {
      ok: false,
      error: "missing_required_body",
      required: [...CHAT_COORDINATE_REQUIRED_FIELDS, "kind"],
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

  if ((kind === "block" || kind === "wait") && !reason) {
    respondJson(response, 400, {
      ok: false,
      error: "missing_reason",
      required: ["reason"],
    });
    return;
  }

  try {
    await options.bridge.postChatState({
      platform,
      conversationId,
      rootMessageId,
      kind,
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

async function handleChatPostFileRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: {
    readonly bridge: SlackAgentBridge;
  },
): Promise<void> {
  let body: Record<string, unknown>;

  try {
    body = await readJsonBody(request);
  } catch (error) {
    respondJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const platform = readPlatform(body.platform);
  const conversationId = readString(body.conversation_id) ?? readString(body.conversationId);
  const rootMessageId = readString(body.root_message_id) ?? readString(body.rootMessageId);
  const filePath = readString(body.file_path) ?? readString(body.filePath);
  const contentBase64 = readString(body.content_base64) ?? readString(body.contentBase64);
  const filename = readString(body.filename);

  logger.raw(
    "http-requests",
    {
      method: "POST",
      path: "/chat/post-file",
      body: redactHttpRequestBody(body),
    },
    {
      platform,
      conversationId,
      rootMessageId,
    },
  );

  if (!platform || !conversationId || !rootMessageId) {
    if (isInvalidPlatformValue(body.platform)) {
      respondJson(response, 400, {
        ok: false,
        error: "invalid_platform",
        allowed: CHAT_PLATFORM_VALUES,
      });
      return;
    }

    respondJson(response, 400, {
      ok: false,
      error: "missing_required_body",
      required: CHAT_COORDINATE_REQUIRED_FIELDS,
    });
    return;
  }

  if (Boolean(filePath) === Boolean(contentBase64)) {
    respondJson(response, 400, {
      ok: false,
      error: "provide_exactly_one_file_source",
      required: CHAT_FILE_SOURCE_FIELD_DESCRIPTIONS,
    });
    return;
  }

  if (contentBase64 && !filename) {
    respondJson(response, 400, {
      ok: false,
      error: "missing_required_body",
      message: CHAT_INLINE_FILE_FILENAME_REQUIREMENT_MESSAGE,
      required: ["filename"],
    });
    return;
  }

  if (contentBase64 && !isNonEmptyBase64Content(contentBase64)) {
    respondJson(response, 400, {
      ok: false,
      error: "invalid_content_base64",
      message: CHAT_INLINE_FILE_CONTENT_REQUIREMENT_MESSAGE,
      required: ["contentBase64 (alias: content_base64)"],
    });
    return;
  }

  try {
    const file = await options.bridge.postChatFile({
      platform,
      conversationId,
      rootMessageId,
      filePath,
      contentBase64,
      filename,
      title: readString(body.title),
      initialComment: readString(body.initial_comment) ?? readString(body.initialComment),
      altText: readString(body.alt_text) ?? readString(body.altText),
      snippetType: readString(body.snippet_type) ?? readString(body.snippetType),
      contentType: readString(body.content_type) ?? readString(body.contentType),
    });
    respondJson(response, 200, {
      ok: true,
      file,
    });
  } catch (error) {
    respondJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function readPlatform(value: unknown): ChatPlatform | undefined {
  return value === "slack" || value === "feishu" ? value : undefined;
}

function isInvalidPlatformValue(value: unknown): boolean {
  return value != null && value !== "" && !readPlatform(value);
}

function readMessageFormat(value: unknown): ChatMessageFormat | undefined {
  return value === "text" || value === "markdown" || value === "rich_text" || value === "card" ? value : undefined;
}

function readHistoryResponseFormat(value: unknown): "json" | "text" | undefined {
  if (value == null) {
    return "json";
  }

  return value === "json" || value === "text" ? value : undefined;
}
