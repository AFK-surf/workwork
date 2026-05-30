import type {
  BackgroundJobEventPayload,
  JsonLike,
  UnexpectedTurnStopPayload
} from "../../types.js";

export type ChatPlatform = "slack" | "feishu";

export const CHAT_PLATFORM_VALUES = ["slack", "feishu"] as const;

export type ChatConversationKind =
  | "channel"
  | "group"
  | "direct"
  | "thread"
  | "unknown";

export type ChatSenderKind =
  | "user"
  | "bot"
  | "app"
  | "system"
  | "unknown";

export type ChatInboundSource =
  | "bot_mention"
  | "direct_message"
  | "thread_reply"
  | "group_message"
  | "background_job_event"
  | "unexpected_turn_stop"
  | "recovered_thread_batch";

export type ChatTurnSignalKind = "progress" | "final" | "block" | "wait";

export type ChatMessageFormat = "text" | "markdown" | "rich_text" | "card";

export const CHAT_FILE_SOURCE_FIELD_DESCRIPTIONS = [
  "filePath (alias: file_path)",
  "contentBase64 (alias: content_base64)"
] as const;

export const CHAT_FILE_SOURCE_REQUIREMENT_MESSAGE =
  "Provide exactly one file source: filePath (alias: file_path) or contentBase64 (alias: content_base64)";

export const CHAT_INLINE_FILE_FILENAME_REQUIREMENT_MESSAGE =
  "filename is required when using contentBase64 (alias: content_base64)";

export const CHAT_INLINE_FILE_CONTENT_REQUIREMENT_MESSAGE =
  "contentBase64 (alias: content_base64) must decode to non-empty file content";

export function isNonEmptyBase64Content(value: string): boolean {
  const normalized = value.replace(/\s+/gu, "");
  if (!normalized) {
    return false;
  }

  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized) || normalized.length % 4 === 1) {
    return false;
  }

  return Buffer.from(normalized, "base64").byteLength > 0;
}

export interface ChatThreadTarget {
  readonly platform: ChatPlatform;
  readonly conversationId: string;
  readonly rootMessageId: string;
  readonly conversationKind?: ChatConversationKind | undefined;
  readonly platformThreadId?: string | undefined;
}

export interface ChatThreadQuery extends ChatThreadTarget {
  readonly beforeMessageId?: string | undefined;
  readonly beforeCursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface ChatUserIdentity {
  readonly platform: ChatPlatform;
  readonly userId: string;
  readonly mention: string;
  readonly username?: string | undefined;
  readonly displayName?: string | undefined;
  readonly realName?: string | undefined;
  readonly email?: string | undefined;
  readonly rawUser?: JsonLike | undefined;
}

export interface ChatAttachment {
  readonly platform: ChatPlatform;
  readonly id: string;
  readonly kind: "image" | "file" | "audio" | "video" | "unknown";
  readonly messageId?: string | undefined;
  readonly name?: string | undefined;
  readonly title?: string | undefined;
  readonly mimetype?: string | undefined;
  readonly size?: number | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly url?: string | undefined;
  readonly resourceKey?: string | undefined;
  readonly rawAttachment?: JsonLike | undefined;
}

export interface ChatSender {
  readonly kind: ChatSenderKind;
  readonly userId: string;
  readonly botId?: string | undefined;
  readonly appId?: string | undefined;
  readonly username?: string | undefined;
  readonly identity?: ChatUserIdentity | null | undefined;
}

export interface ChatThreadMessage extends ChatThreadTarget {
  readonly messageId: string;
  readonly eventId?: string | undefined;
  readonly messageCursor?: string | undefined;
  readonly parentMessageId?: string | undefined;
  readonly source: ChatInboundSource;
  readonly sender: ChatSender;
  readonly text: string;
  readonly format?: ChatMessageFormat | undefined;
  readonly mentionedUserIds?: readonly string[] | undefined;
  readonly mentionedUsers?: readonly ChatUserIdentity[] | undefined;
  readonly attachments?: readonly ChatAttachment[] | undefined;
  readonly rawMessage?: JsonLike | undefined;
  readonly backgroundJob?: BackgroundJobEventPayload | undefined;
  readonly unexpectedTurnStop?: UnexpectedTurnStopPayload | undefined;
}

export interface ChatThreadPage {
  readonly messages: readonly ChatThreadMessage[];
  readonly hasMore: boolean;
  readonly nextCursor?: string | undefined;
}

export interface ChatInputMessage extends ChatThreadMessage {
  readonly contextText?: string | undefined;
  readonly recoveryKind?: "missed_thread_messages" | undefined;
  readonly batchMessages?: readonly ChatThreadMessage[] | undefined;
}

export interface ChatOutboundMessage {
  readonly text: string;
  readonly format?: ChatMessageFormat | undefined;
  readonly kind?: ChatTurnSignalKind | undefined;
  readonly reason?: string | undefined;
  readonly richText?: JsonLike | undefined;
  readonly card?: JsonLike | undefined;
}

export interface ChatTurnState {
  readonly kind: Exclude<ChatTurnSignalKind, "progress">;
  readonly reason?: string | undefined;
}

export interface ChatOutboundFile {
  readonly filePath?: string | undefined;
  readonly contentBase64?: string | undefined;
  readonly filename?: string | undefined;
  readonly title?: string | undefined;
  readonly initialComment?: string | undefined;
  readonly altText?: string | undefined;
  readonly snippetType?: string | undefined;
  readonly contentType?: string | undefined;
}

export interface ChatPostedMessage {
  readonly platform: ChatPlatform;
  readonly conversationId: string;
  readonly rootMessageId: string;
  readonly messageId?: string | undefined;
  readonly messageCursor?: string | undefined;
  readonly rawResponse?: JsonLike | undefined;
}

export interface ChatUploadedFile {
  readonly platform: ChatPlatform;
  readonly fileId: string;
  readonly kind?: "image" | "file" | undefined;
  readonly title?: string | undefined;
  readonly name?: string | undefined;
  readonly mimetype?: string | undefined;
  readonly permalink?: string | undefined;
  readonly downloadUrl?: string | undefined;
  readonly size?: number | undefined;
  readonly rawResponse?: JsonLike | undefined;
}
