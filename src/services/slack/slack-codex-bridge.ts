import type { AppConfig } from "../../config.js";
import { logger } from "../../logger.js";
import type { ChatMessageFormat, ChatPlatform, ChatUploadedFile } from "../chat/chat-types.js";
import type {
  BackgroundJobEventPayload,
  JsonLike,
  ResolvedSlackThreadMessage,
  SlackSessionRecord,
  SlackUserIdentity
} from "../../types.js";
import { CodexBroker } from "../codex/codex-broker.js";
import { FeishuCodexBridge } from "../feishu/feishu-codex-bridge.js";
import { FeishuPlatformAdapter } from "../feishu/feishu-platform-adapter.js";
import { GitHubAuthorMappingService } from "../github-author-mapping-service.js";
import { SessionManager } from "../session-manager.js";
import {
  type ParsedSlackEvent,
  isSlackMessageEffectivelyEmpty,
  parseSlackEvent
} from "./slack-event-parser.js";
import { SlackApi, type SlackUploadedFile } from "./slack-api.js";
import { SlackCoauthorService } from "./slack-coauthor-service.js";
import { SlackConversationService } from "./slack-conversation-service.js";
import { SlackSelfMessageFilter } from "./slack-self-filter.js";
import { SlackSocketModeClient } from "./socket-mode-client.js";

export class SlackCodexBridge {
  readonly #config: AppConfig;
  readonly #sessions: SessionManager;
  readonly #codex: CodexBroker;
  readonly #slackApi: SlackApi;
  readonly #slackSocket: SlackSocketModeClient;
  readonly #selfMessageFilter = new SlackSelfMessageFilter();
  readonly #mappings: GitHubAuthorMappingService;
  readonly #coauthors: SlackCoauthorService;
  readonly #conversations: SlackConversationService;
  readonly #feishuBridge?: FeishuCodexBridge | undefined;
  #botUserId = "";
  #botIdentity: SlackUserIdentity | null = null;

  constructor(options: {
    readonly config: AppConfig;
    readonly sessions: SessionManager;
    readonly codex: CodexBroker;
    readonly mappings: GitHubAuthorMappingService;
    readonly feishuBridge?: FeishuCodexBridge | undefined;
  }) {
    this.#config = options.config;
    this.#sessions = options.sessions;
    this.#codex = options.codex;
    this.#slackApi = new SlackApi({
      baseUrl: this.#config.slackApiBaseUrl,
      appToken: this.#config.slackAppToken,
      botToken: this.#config.slackBotToken
    });
    this.#slackSocket = new SlackSocketModeClient({
      api: this.#slackApi,
      socketOpenPath: this.#config.slackSocketOpenUrl
    });
    this.#mappings = options.mappings;
    this.#coauthors = new SlackCoauthorService({
      sessions: this.#sessions,
      slackApi: this.#slackApi,
      mappings: options.mappings
    });
    this.#conversations = new SlackConversationService({
      config: this.#config,
      sessions: this.#sessions,
      codex: this.#codex,
      slackApi: this.#slackApi,
      selfMessageFilter: this.#selfMessageFilter,
      coauthors: this.#coauthors
    });
    this.#feishuBridge = options.feishuBridge ?? this.#createFeishuBridge();
  }

  async start(): Promise<void> {
    await this.#sessions.load();
    await this.#codex.start();

    const auth = await this.#slackApi.authTest();
    this.#botUserId = auth.userId;
    this.#selfMessageFilter.setIdentity(auth);
    this.#conversations.setBotUserId(auth.userId);

    this.#botIdentity = await this.#slackApi.getUserIdentity(this.#botUserId);
    this.#codex.setSlackBotIdentity(this.#botIdentity);

    await this.#conversations.start();
    await this.#startFeishuBridge();

    this.#slackSocket.on("ready", () => {
      void this.#conversations.recoverMissedThreadMessages("socket_ready");
    });
    this.#slackSocket.on("events_api", (payload) => {
      void this.#handleEventsApi(payload as {
        readonly event?: Record<string, any>;
        readonly event_id?: string;
      });
    });
    this.#slackSocket.on("interactive", (payload) => {
      void this.#handleInteractive(payload as Record<string, unknown>);
    });

    await this.#slackSocket.start();
  }

  async stop(): Promise<void> {
    await this.#feishuBridge?.stop();
    await this.#slackSocket.stop();
    await this.#conversations.stop();
    await this.#codex.stop();
  }

  async readThreadHistory(options: {
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly beforeMessageTs?: string | undefined;
    readonly limit?: number | undefined;
    readonly channelType?: string | undefined;
  }): Promise<{
    readonly messages: readonly ResolvedSlackThreadMessage[];
    readonly formattedText?: string | undefined;
    readonly hasMore: boolean;
  }> {
    return await this.#conversations.readThreadHistory(options);
  }

  async readChatThreadHistory(options: {
    readonly platform: ChatPlatform;
    readonly conversationId: string;
    readonly rootMessageId: string;
    readonly beforeMessageId?: string | undefined;
    readonly beforeCursor?: string | undefined;
    readonly channelType?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<{
    readonly messages: readonly unknown[];
    readonly formattedText?: string | undefined;
    readonly hasMore: boolean;
    readonly nextCursor?: string | undefined;
  }> {
    if (options.platform === "feishu") {
      if (!this.#feishuBridge) {
        throw new Error("Feishu platform is not enabled.");
      }

      return await this.#feishuBridge.readChatThreadHistory({
        conversationId: options.conversationId,
        rootMessageId: options.rootMessageId,
        beforeMessageId: options.beforeMessageId,
        beforeCursor: options.beforeCursor,
        limit: options.limit
      });
    }

    if (options.platform !== "slack") {
      throw new Error(`Chat platform is not available through this runtime yet: ${options.platform}`);
    }

    return await this.readThreadHistory({
      channelId: options.conversationId,
      rootThreadTs: options.rootMessageId,
      beforeMessageTs: options.beforeMessageId ?? options.beforeCursor,
      channelType: options.channelType,
      limit: options.limit
    });
  }

  async replayThreadMessage(options: {
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly messageTs: string;
  }) {
    return await this.#conversations.replayThreadMessage(options);
  }

  async resumePendingSession(options: {
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly forceReset?: boolean | undefined;
  }) {
    return await this.#conversations.resumePendingSession(options);
  }

  async acceptBackgroundJobEvent(options: {
    readonly platform?: ChatPlatform | undefined;
    readonly conversationId?: string | undefined;
    readonly rootMessageId?: string | undefined;
    readonly channelId?: string | undefined;
    readonly rootThreadTs?: string | undefined;
    readonly payload: BackgroundJobEventPayload;
  }): Promise<void> {
    const platform = options.platform ?? "slack";
    const conversationId = options.conversationId ?? options.channelId;
    const rootMessageId = options.rootMessageId ?? options.rootThreadTs;

    if (!conversationId || !rootMessageId) {
      throw new Error("Background job event is missing chat coordinates");
    }

    if (platform === "feishu") {
      if (!this.#feishuBridge) {
        throw new Error("Feishu platform is not enabled.");
      }

      await this.#feishuBridge.acceptBackgroundJobEvent({
        conversationId,
        rootMessageId,
        payload: options.payload
      });
      return;
    }

    if (platform !== "slack") {
      throw new Error(`Chat platform is not available through this runtime yet: ${platform}`);
    }

    await this.#conversations.acceptBackgroundJobEvent({
      channelId: conversationId,
      rootThreadTs: rootMessageId,
      payload: options.payload
    });
  }

  async postSlackMessage(options: {
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly text: string;
    readonly kind?: "progress" | "final" | "block" | "wait" | undefined;
    readonly reason?: string | undefined;
  }): Promise<void> {
    await this.#conversations.postSlackMessage(options);
  }

  async postChatMessage(options: {
    readonly platform: ChatPlatform;
    readonly conversationId: string;
    readonly rootMessageId: string;
    readonly text: string;
    readonly format?: ChatMessageFormat | undefined;
    readonly kind?: "progress" | "final" | "block" | "wait" | undefined;
    readonly reason?: string | undefined;
    readonly richText?: JsonLike | undefined;
    readonly card?: JsonLike | undefined;
  }): Promise<void> {
    if (options.platform === "feishu") {
      if (!this.#feishuBridge) {
        throw new Error("Feishu platform is not enabled.");
      }

      await this.#feishuBridge.postChatMessage({
        conversationId: options.conversationId,
        rootMessageId: options.rootMessageId,
        text: options.text,
        format: options.format,
        kind: options.kind,
        reason: options.reason,
        richText: options.richText,
        card: options.card
      });
      return;
    }

    if (options.platform !== "slack") {
      throw new Error(`Chat platform is not available through this runtime yet: ${options.platform}`);
    }

    await this.postSlackMessage({
      channelId: options.conversationId,
      rootThreadTs: options.rootMessageId,
      text: options.text,
      kind: options.kind,
      reason: options.reason
    });
  }

  async postSlackState(options: {
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly kind: "wait" | "block" | "final";
    readonly reason?: string | undefined;
  }): Promise<void> {
    await this.#conversations.postSlackState(options);
  }

  async postChatState(options: {
    readonly platform: ChatPlatform;
    readonly conversationId: string;
    readonly rootMessageId: string;
    readonly kind: "wait" | "block" | "final";
    readonly reason?: string | undefined;
  }): Promise<void> {
    if (options.platform === "feishu") {
      if (!this.#feishuBridge) {
        throw new Error("Feishu platform is not enabled.");
      }

      await this.#feishuBridge.postChatState({
        conversationId: options.conversationId,
        rootMessageId: options.rootMessageId,
        kind: options.kind,
        reason: options.reason
      });
      return;
    }

    if (options.platform !== "slack") {
      throw new Error(`Chat platform is not available through this runtime yet: ${options.platform}`);
    }

    await this.postSlackState({
      channelId: options.conversationId,
      rootThreadTs: options.rootMessageId,
      kind: options.kind,
      reason: options.reason
    });
  }

  async postSlackFile(options: {
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly filePath?: string | undefined;
    readonly contentBase64?: string | undefined;
    readonly filename?: string | undefined;
    readonly title?: string | undefined;
    readonly initialComment?: string | undefined;
    readonly altText?: string | undefined;
    readonly snippetType?: string | undefined;
    readonly contentType?: string | undefined;
  }) {
    return await this.#conversations.postSlackFile(options);
  }

  async postChatFile(options: {
    readonly platform: ChatPlatform;
    readonly conversationId: string;
    readonly rootMessageId: string;
    readonly filePath?: string | undefined;
    readonly contentBase64?: string | undefined;
    readonly filename?: string | undefined;
    readonly title?: string | undefined;
    readonly initialComment?: string | undefined;
    readonly altText?: string | undefined;
    readonly snippetType?: string | undefined;
    readonly contentType?: string | undefined;
  }): Promise<ChatUploadedFile> {
    if (options.platform === "feishu") {
      if (!this.#feishuBridge) {
        throw new Error("Feishu platform is not enabled.");
      }

      return await this.#feishuBridge.postChatFile({
        conversationId: options.conversationId,
        rootMessageId: options.rootMessageId,
        filePath: options.filePath,
        contentBase64: options.contentBase64,
        filename: options.filename,
        title: options.title,
        initialComment: options.initialComment,
        altText: options.altText,
        snippetType: options.snippetType,
        contentType: options.contentType
      });
    }

    if (options.platform !== "slack") {
      throw new Error(`Chat platform is not available through this runtime yet: ${options.platform}`);
    }

    const uploaded = await this.postSlackFile({
      channelId: options.conversationId,
      rootThreadTs: options.rootMessageId,
      filePath: options.filePath,
      contentBase64: options.contentBase64,
      filename: options.filename,
      title: options.title,
      initialComment: options.initialComment,
      altText: options.altText,
      snippetType: options.snippetType,
      contentType: options.contentType
    });
    return {
      platform: "slack",
      ...uploaded
    };
  }

  #createFeishuBridge(): FeishuCodexBridge | undefined {
    if (!this.#config.feishuEnabled) {
      return undefined;
    }

    return new FeishuCodexBridge({
      sessions: this.#sessions,
      codex: this.#codex,
      groupMessageMode: this.#config.feishuGroupMessageMode,
      initialThreadHistoryCount: this.#config.feishuInitialThreadHistoryCount,
      historyApiMaxLimit: this.#config.feishuHistoryApiMaxLimit,
      mappings: this.#mappings,
      adapter: new FeishuPlatformAdapter({
        appId: this.#config.feishuAppId!,
        appSecret: this.#config.feishuAppSecret!,
        apiBaseUrl: this.#config.feishuApiBaseUrl,
        botIdentity: {
          openId: this.#config.feishuBotOpenId,
          userId: this.#config.feishuBotUserId,
          unionId: this.#config.feishuBotUnionId
        },
        groupMessageMode: this.#config.feishuGroupMessageMode,
        startupRequired: this.#config.feishuStartupRequired
      })
    });
  }

  async #startFeishuBridge(): Promise<void> {
    if (!this.#feishuBridge) {
      return;
    }

    try {
      await this.#feishuBridge.start();
      if (this.#config.feishuGroupMessageMode === "at_only") {
        logger.warn("chat.platform.degraded", {
          platform: "feishu",
          source: "long_connection",
          groupMessageMode: this.#config.feishuGroupMessageMode,
          startupRequired: this.#config.feishuStartupRequired,
          degradedReason: "group_message_all_unavailable",
          permission: "im:message.group_msg"
        });
      } else if (!this.#config.feishuAllMessageDeliveryVerified) {
        logger.warn("chat.platform.degraded", {
          platform: "feishu",
          source: "long_connection",
          groupMessageMode: this.#config.feishuGroupMessageMode,
          startupRequired: this.#config.feishuStartupRequired,
          degradedReason: "all_message_delivery_unverified",
          permission: "im:message.group_msg"
        });
      }
    } catch (error) {
      logger.warn("chat.platform.degraded", {
        platform: "feishu",
        source: "long_connection",
        groupMessageMode: this.#config.feishuGroupMessageMode,
        startupRequired: this.#config.feishuStartupRequired,
        degradedReason: "startup_failed",
        errorClass: error instanceof Error ? error.name : "Error"
      });

      if (this.#config.feishuStartupRequired) {
        throw error;
      }
    }
  }

  async listGitHubAuthorMappings() {
    return await this.#coauthors.listMappings();
  }

  async upsertGitHubAuthorMapping(options: {
    readonly slackUserId: string;
    readonly githubAuthor: string;
  }) {
    return await this.#coauthors.upsertManualMapping(options);
  }

  async deleteGitHubAuthorMapping(slackUserId: string): Promise<void> {
    await this.#coauthors.deleteMapping(slackUserId);
  }

  async resolveCommitCoauthors(options: {
    readonly cwd: string;
    readonly commitMessage: string;
    readonly primaryAuthorEmail?: string | undefined;
  }) {
    const session = this.#sessions.findSessionByWorkspace(options.cwd);
    if (session?.platform === "feishu") {
      if (!this.#feishuBridge) {
        return {
          status: "blocked",
          sessionKey: session.key,
          errorCode: "feishu_coauthor_bridge_unavailable",
          message: "Commit blocked by Feishu co-author gate, but Feishu is not available in this runtime."
        };
      }

      return await this.#feishuBridge.resolveCommitCoauthors(options);
    }

    return await this.#coauthors.resolveCommitCoauthors(options);
  }

  async #handleEventsApi(payload: {
    readonly event?: Record<string, any>;
    readonly event_id?: string;
  }): Promise<void> {
    if (!payload.event || !payload.event_id) {
      return;
    }

    if (this.#sessions.hasProcessedEvent(payload.event_id)) {
      return;
    }

    try {
      await this.#routeSlackEvent(payload.event);
      await this.#sessions.markProcessedEvent(payload.event_id);
    } catch (error) {
      logger.error("Failed to process Slack event", {
        eventId: payload.event_id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async #handleInteractive(payload: Record<string, unknown>): Promise<void> {
    try {
      await this.#coauthors.handleInteractivePayload(payload);
    } catch (error) {
      logger.error("Failed to process Slack interactive payload", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async #routeSlackEvent(event: Record<string, any>): Promise<void> {
    if (this.#selfMessageFilter.shouldIgnoreEvent(event)) {
      return;
    }

    const parsed = parseSlackEvent(event, this.#botUserId);
    if (!parsed) {
      return;
    }

    switch (parsed.route) {
      case "app_mention":
        await this.#handleInteractiveSessionEvent(parsed, {
          createSession: true,
          preloadHistory: parsed.rootThreadTs !== parsed.messageTs
        });
        return;
      case "direct_message":
        if (parsed.controlText === "-stop" && (parsed.input.images?.length ?? 0) === 0) {
          const existing = this.#sessions.getSession(parsed.channelId, parsed.rootThreadTs);
          if (existing) {
            await this.#handleStop(existing);
          }
          return;
        }

        await this.#handleInteractiveSessionEvent(parsed, {
          createSession: true,
          preloadHistory: false
        });
        return;
      case "thread_reply": {
        const session = this.#sessions.getSession(parsed.channelId, parsed.rootThreadTs);
        if (!session) {
          return;
        }

        if (this.#conversations.isAlreadyHandled(session, parsed.messageTs)) {
          return;
        }

        if (parsed.controlText === "-stop" && (parsed.input.images?.length ?? 0) === 0) {
          await this.#handleStop(session);
          return;
        }

        if (isSlackMessageEffectivelyEmpty(parsed.input.text, parsed.input.images, parsed.input.slackMessage)) {
          return;
        }

        await this.#conversations.acceptInboundMessage(session, parsed.input);
        return;
      }
      default:
        return;
    }
  }

  async #handleInteractiveSessionEvent(
    parsed: ParsedSlackEvent,
    options: {
      readonly createSession: boolean;
      readonly preloadHistory: boolean;
    }
  ): Promise<void> {
    const existing = this.#sessions.getSession(parsed.channelId, parsed.rootThreadTs);
    let session = options.createSession
      ? await this.#sessions.ensureSession(parsed.channelId, parsed.rootThreadTs)
      : existing;

    if (!session) {
      return;
    }

    if (this.#conversations.isAlreadyHandled(session, parsed.messageTs)) {
      return;
    }

    if (!existing) {
      await this.#conversations.postSlackMessage({
        channelId: parsed.channelId,
        rootThreadTs: parsed.rootThreadTs,
        text: "I've joined this thread and I'm checking the context now. I'll be with you shortly."
      });
    }

    session = await this.#conversations.ensureCodexThread(session);

    if (isSlackMessageEffectivelyEmpty(parsed.input.text, parsed.input.images, parsed.input.slackMessage)) {
      return;
    }

    const history = !existing && options.preloadHistory && parsed.messageTs
      ? await this.#conversations.readThreadHistory({
        channelId: parsed.channelId,
        channelType: parsed.channelType,
        rootThreadTs: parsed.rootThreadTs,
        beforeMessageTs: parsed.messageTs,
        limit: this.#config.slackInitialThreadHistoryCount
      })
      : undefined;

    await this.#conversations.acceptInboundMessage(session, {
      ...parsed.input,
      contextText: history?.formattedText
    });
  }

  async #handleStop(session: SlackSessionRecord): Promise<void> {
    const stopped = await this.#conversations.stopActiveTurn(session);
    await this.#conversations.postSlackMessage({
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      text: stopped ? "Stopped the current run." : "No active run to stop."
    });
  }
}
