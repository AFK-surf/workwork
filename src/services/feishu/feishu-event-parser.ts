import type { ChatAttachment, ChatInboundSource, ChatInputMessage, ChatSender, ChatUserIdentity } from "../chat/chat-types.js";
import type { JsonLike } from "../../types.js";

export interface FeishuBotIdentity {
  readonly appId?: string | undefined;
  readonly openId?: string | undefined;
  readonly userId?: string | undefined;
  readonly unionId?: string | undefined;
}

export interface ParsedFeishuMessageEvent {
  readonly route: "bot_mention" | "thread_reply" | "group_message";
  readonly controlText: string;
  readonly input: ChatInputMessage;
}

export type FeishuIgnoredReason = "ignored_invalid_event" | "ignored_private_chat" | "ignored_self";

export interface IgnoredFeishuMessageEvent {
  readonly route: "ignored";
  readonly ignoredReason: FeishuIgnoredReason;
  readonly conversationId?: string | undefined;
  readonly conversationKind: "direct" | "group" | "unknown";
  readonly messageId?: string | undefined;
  readonly eventId?: string | undefined;
  readonly senderKind?: ChatSender["kind"] | undefined;
}

export type RoutedFeishuMessageEvent =
  | {
      readonly route: "accepted";
      readonly parsed: ParsedFeishuMessageEvent;
    }
  | IgnoredFeishuMessageEvent;

export function parseFeishuReceiveMessageEvent(
  payload: unknown,
  options?: {
    readonly botIdentity?: FeishuBotIdentity | undefined;
  },
): ParsedFeishuMessageEvent | null {
  const routed = routeFeishuReceiveMessageEvent(payload, options);
  return routed.route === "accepted" ? routed.parsed : null;
}

export function routeFeishuReceiveMessageEvent(
  payload: unknown,
  options?: {
    readonly botIdentity?: FeishuBotIdentity | undefined;
  },
): RoutedFeishuMessageEvent {
  const event = unwrapFeishuEvent(payload);
  const message = asRecord(event?.message);
  const senderPayload = asRecord(event?.sender);

  if (!message || !senderPayload) {
    return {
      route: "ignored",
      ignoredReason: "ignored_invalid_event",
      conversationKind: "unknown",
      eventId: readEventId(payload),
    };
  }

  const chatType = readString(message.chat_type);
  if (chatType !== "group") {
    return {
      route: "ignored",
      ignoredReason: "ignored_private_chat",
      conversationId: readString(message.chat_id),
      conversationKind: chatType === "p2p" ? "direct" : "unknown",
      messageId: readString(message.message_id),
      eventId: readEventId(payload),
      senderKind: buildSender(senderPayload).kind,
    };
  }

  const conversationId = readString(message.chat_id);
  const messageId = readString(message.message_id);
  if (!conversationId || !messageId) {
    return {
      route: "ignored",
      ignoredReason: "ignored_invalid_event",
      conversationId,
      conversationKind: "group",
      messageId,
      eventId: readEventId(payload),
      senderKind: buildSender(senderPayload).kind,
    };
  }

  const sender = buildSender(senderPayload);
  if (isBotSelf(sender, options?.botIdentity) || senderMatchesBotIdentity(senderPayload, options?.botIdentity)) {
    return {
      route: "ignored",
      ignoredReason: "ignored_self",
      conversationId,
      conversationKind: "group",
      messageId,
      eventId: readEventId(payload),
      senderKind: sender.kind,
    };
  }

  const parentMessageId = readString(message.parent_id);
  const rootMessageId = readString(message.root_id) || parentMessageId || messageId;
  const platformThreadId = readString(message.thread_id);
  const messageType = readString(message.message_type) ?? "text";
  const content = parseFeishuContent(message.content);
  const mentions = readMentions(message.mentions);
  const mentionedUsers = mentions.map((mention) => mention.identity);
  const mentionedUserIds = mentionedUsers.map((identity) => identity.userId);
  const mentionedBot = mentions.some((mention) => mentionMatchesBot(mention, options?.botIdentity));
  const source: ChatInboundSource = mentionedBot ? "bot_mention" : parentMessageId || rootMessageId !== messageId ? "thread_reply" : "group_message";
  const text = formatFeishuMessageText(messageType, content);
  const controlText = removeBotMentions(text, mentions, options?.botIdentity).trim();

  return {
    route: "accepted",
    parsed: {
      route: source === "bot_mention" ? "bot_mention" : source === "thread_reply" ? "thread_reply" : "group_message",
      controlText,
      input: {
        platform: "feishu",
        conversationId,
        conversationKind: "group",
        rootMessageId,
        platformThreadId,
        messageId,
        eventId: readEventId(payload),
        messageCursor: readString(message.create_time),
        parentMessageId,
        source,
        sender,
        text,
        format: formatForMessageType(messageType),
        mentionedUserIds,
        mentionedUsers,
        attachments: buildAttachments(messageType, content, messageId),
        rawMessage: normalizeJson(message),
      },
    },
  };
}

function unwrapFeishuEvent(payload: unknown): Record<string, unknown> | undefined {
  const record = asRecord(payload);
  if (!record) {
    return undefined;
  }

  return asRecord(record.event) ?? record;
}

function readEventId(payload: unknown): string | undefined {
  const record = asRecord(payload);
  const header = asRecord(record?.header);
  return readString(header?.event_id) ?? readString(record?.event_id);
}

function buildSender(senderPayload: Record<string, unknown>): ChatSender {
  const senderId = asRecord(senderPayload.sender_id);
  const userId = readString(senderId?.open_id) ?? readString(senderId?.user_id) ?? readString(senderId?.union_id) ?? readString(senderId?.app_id) ?? "unknown:feishu-message";
  const senderType = readString(senderPayload.sender_type);

  return {
    kind: senderType === "user" ? "user" : senderType === "bot" ? "bot" : senderType === "app" ? "app" : "unknown",
    userId,
    appId: readString(senderId?.app_id),
  };
}

function isBotSelf(sender: ChatSender, botIdentity?: FeishuBotIdentity): boolean {
  if (sender.kind === "bot" || sender.kind === "app") {
    return true;
  }

  if (!botIdentity) {
    return false;
  }

  return Boolean((botIdentity.openId && sender.userId === botIdentity.openId) || (botIdentity.userId && sender.userId === botIdentity.userId) || (botIdentity.unionId && sender.userId === botIdentity.unionId) || (sender.kind !== "user" && botIdentity.appId && sender.appId === botIdentity.appId));
}

function senderMatchesBotIdentity(senderPayload: Record<string, unknown>, botIdentity?: FeishuBotIdentity): boolean {
  if (!botIdentity) {
    return false;
  }

  const senderId = asRecord(senderPayload.sender_id);
  return Boolean(
    (botIdentity.openId && readString(senderId?.open_id) === botIdentity.openId) ||
    (botIdentity.userId && readString(senderId?.user_id) === botIdentity.userId) ||
    (botIdentity.unionId && readString(senderId?.union_id) === botIdentity.unionId) ||
    (botIdentity.appId && readString(senderId?.app_id) === botIdentity.appId),
  );
}

function parseFeishuContent(value: unknown): JsonLike | undefined {
  if (typeof value === "string") {
    try {
      return normalizeJson(JSON.parse(value));
    } catch {
      return value;
    }
  }

  return normalizeJson(value);
}

function formatForMessageType(messageType: string) {
  switch (messageType) {
    case "post":
      return "rich_text" as const;
    case "interactive":
      return "card" as const;
    default:
      return "text" as const;
  }
}

function formatFeishuMessageText(messageType: string, content: JsonLike | undefined): string {
  const contentRecord = asJsonRecord(content);

  if (messageType === "text") {
    return readString(contentRecord?.text) ?? "";
  }

  if (messageType === "post") {
    const title = readString(contentRecord?.title);
    const body = extractTextFragments(contentRecord?.content ?? content)
      .join("")
      .trim();
    return [title, body].filter(Boolean).join("\n") || "[Feishu rich text message]";
  }

  if (messageType === "interactive") {
    const title = readString(asJsonRecord(asJsonRecord(asJsonRecord(contentRecord?.config)?.header)?.title)?.content) ?? readString(asJsonRecord(contentRecord?.header)?.title) ?? readString(contentRecord?.title);
    return title ? `[Feishu card: ${title}]` : "[Feishu interactive card]";
  }

  if (messageType === "image") {
    return "[Feishu image]";
  }

  if (messageType === "file") {
    return readString(contentRecord?.file_name) ?? "[Feishu file]";
  }

  return extractTextFragments(content).join("").trim() || `[Feishu ${messageType} message]`;
}

function buildAttachments(messageType: string, content: JsonLike | undefined, messageId: string): readonly ChatAttachment[] {
  const contentRecord = asJsonRecord(content);

  if (messageType === "image") {
    const imageKey = readString(contentRecord?.image_key);
    if (!imageKey) {
      return [];
    }

    return [
      {
        platform: "feishu",
        id: imageKey,
        kind: "image",
        messageId,
        resourceKey: imageKey,
        rawAttachment: content,
      },
    ];
  }

  if (messageType === "file") {
    const fileKey = readString(contentRecord?.file_key);
    if (!fileKey) {
      return [];
    }

    return [
      {
        platform: "feishu",
        id: fileKey,
        kind: "file",
        messageId,
        name: readString(contentRecord?.file_name),
        resourceKey: fileKey,
        rawAttachment: content,
      },
    ];
  }

  return [];
}

interface FeishuMention {
  readonly key?: string | undefined;
  readonly identity: ChatUserIdentity;
}

function readMentions(value: unknown): readonly FeishuMention[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry): FeishuMention[] => {
    const mention = asRecord(entry);
    const id = asRecord(mention?.id);
    const userId = readString(id?.open_id) ?? readString(id?.user_id) ?? readString(id?.union_id) ?? readString(mention?.id);
    if (!mention || !userId) {
      return [];
    }

    const name = readString(mention.name);
    return [
      {
        key: readString(mention.key),
        identity: {
          platform: "feishu",
          userId,
          mention: name ? `@${name}` : `@${userId}`,
          displayName: name,
          rawUser: normalizeJson(mention),
        },
      },
    ];
  });
}

function mentionMatchesBot(mention: FeishuMention, botIdentity?: FeishuBotIdentity): boolean {
  if (!botIdentity) {
    return false;
  }

  const rawUser = asJsonRecord(mention.identity.rawUser);
  const id = asJsonRecord(rawUser?.id);
  return Boolean((botIdentity.openId && mention.identity.userId === botIdentity.openId) || (botIdentity.userId && readString(id?.user_id) === botIdentity.userId) || (botIdentity.unionId && readString(id?.union_id) === botIdentity.unionId));
}

function removeBotMentions(text: string, mentions: readonly FeishuMention[], botIdentity?: FeishuBotIdentity): string {
  let normalized = text;

  for (const mention of mentions) {
    if (!mentionMatchesBot(mention, botIdentity)) {
      continue;
    }

    if (mention.key) {
      normalized = normalized.replaceAll(mention.key, "");
    }
    normalized = normalized.replaceAll(mention.identity.mention, "");
  }

  return normalized;
}

function extractTextFragments(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractTextFragments(entry));
  }

  const record = asRecord(value);
  if (!record) {
    return [];
  }

  const current = typeof record.text === "string" ? [record.text] : [];
  return [
    ...current,
    ...Object.entries(record)
      .filter(([key]) => key !== "text" && key !== "tag")
      .flatMap(([, entry]) => extractTextFragments(entry)),
  ];
}

function normalizeJson(value: unknown): JsonLike | undefined {
  if (value === null) {
    return null;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJson(entry)).filter((entry): entry is JsonLike => entry !== undefined);
  }

  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(record)
      .map(([key, entry]) => [key, normalizeJson(entry)] as const)
      .filter(([, entry]) => entry !== undefined),
  ) as Record<string, JsonLike>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function asJsonRecord(value: unknown): Record<string, JsonLike> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  return record as Record<string, JsonLike>;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
