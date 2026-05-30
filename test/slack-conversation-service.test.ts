import { EventEmitter } from "node:events";

import fs from "node:fs/promises";

import os from "node:os";

import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";

import { AuthProfileUnavailableError } from "../src/services/agent-runtime/session-auth-profile-runtime.js";

import { SlackConversationService } from "../src/services/slack/slack-conversation-service.js";

import { SlackApiError } from "../src/services/slack/slack-api.js";

import { SessionManager } from "../src/services/session-manager.js";

import { StateStore } from "../src/store/state-store.js";

import type { PersistedAgentTraceEvent, PersistedInboundMessage, SlackSessionRecord } from "../src/types.js";

import { TEST_SESSION, TEST_CONFIG } from "./slack-conversation-service-helpers.js";
import { readCompanionSource } from "./source-helpers.js";

describe("SlackConversationService", () => {
  it("does not block startup on persisted active turn reconciliation", async () => {
    const agentRuntime = new EventEmitter();
    const never = new Promise<never>(() => {});
    const service = new SlackConversationService({
      config: TEST_CONFIG,
      sessions: {
        listSessions: vi.fn(() => [TEST_SESSION]),
        getSessionByKey: vi.fn(() => TEST_SESSION),
        setActiveTurnId: vi.fn(),
        upsertAgentTraceEvent: vi.fn(),
      } as never,
      agentRuntime: Object.assign(agentRuntime, {
        ensureSession: vi.fn(async () => ({ id: TEST_SESSION.agentSessionId })),
        readTurn: vi.fn(() => never),
      }) as never,
      slackApi: {
        setAssistantThreadStatus: vi.fn(),
        addReaction: vi.fn(),
        removeReaction: vi.fn(),
      } as never,
      selfMessageFilter: {} as never,
    });

    const startup = service.start().then(() => "started");
    await expect(Promise.race([startup, new Promise((resolve) => setTimeout(() => resolve("blocked"), 50))])).resolves.toBe("started");

    await service.stop();
  });

  it("coalesces live active-turn reconcile timer ticks instead of overlapping passes", async () => {
    const source = await readCompanionSource(new URL("../src/services/slack/slack-conversation-service.ts", import.meta.url));

    expect(source).toContain("privateActiveTurnReconcilePromise");
    expect(source).toContain("privateRunLiveActiveTurnReconcileOnce");
    expect(source).toMatch(/if \(\s*this\.privateActiveTurnReconcilePromise\s*\)/);
  });

  it("removes the agent runtime event listener on stop", async () => {
    const agentRuntime = new EventEmitter();
    const getSessionByKey = vi.fn(() => TEST_SESSION);
    const setAssistantThreadStatus = vi.fn(async () => undefined);

    const service = new SlackConversationService({
      config: TEST_CONFIG,
      sessions: {
        getSessionByKey,
        upsertAgentTraceEvent: vi.fn(),
      } as never,
      agentRuntime: agentRuntime as never,
      slackApi: {
        setAssistantThreadStatus,
        addReaction: vi.fn(),
        removeReaction: vi.fn(),
      } as never,
      selfMessageFilter: {} as never,
    });

    expect(agentRuntime.listenerCount("event")).toBe(1);

    agentRuntime.emit("event", {
      type: "agent.tool.started",
      agentSessionId: TEST_SESSION.agentSessionId,
      brokerSessionKey: TEST_SESSION.key,
      turnId: TEST_SESSION.activeTurnId,
      callId: "call-1",
      name: "exec_command",
      at: new Date().toISOString(),
    });

    await vi.waitFor(() => {
      expect(setAssistantThreadStatus).toHaveBeenCalledTimes(1);
    });

    await service.stop();

    expect(agentRuntime.listenerCount("event")).toBe(0);
    expect(setAssistantThreadStatus).toHaveBeenCalledTimes(2);

    agentRuntime.emit("event", {
      type: "agent.tool.started",
      agentSessionId: TEST_SESSION.agentSessionId,
      brokerSessionKey: TEST_SESSION.key,
      turnId: TEST_SESSION.activeTurnId,
      callId: "call-2",
      name: "exec_command",
      at: new Date().toISOString(),
    });

    await Promise.resolve();
    expect(setAssistantThreadStatus).toHaveBeenCalledTimes(2);
  });

  it("skips runtime events without a broker session key", async () => {
    const agentRuntime = new EventEmitter();
    const getSessionByKey = vi.fn(() => TEST_SESSION);
    const setAssistantThreadStatus = vi.fn(async () => undefined);

    const service = new SlackConversationService({
      config: TEST_CONFIG,
      sessions: {
        getSessionByKey,
        upsertAgentTraceEvent: vi.fn(),
      } as never,
      agentRuntime: agentRuntime as never,
      slackApi: {
        setAssistantThreadStatus,
        addReaction: vi.fn(),
        removeReaction: vi.fn(),
      } as never,
      selfMessageFilter: {} as never,
    });

    agentRuntime.emit("event", {
      type: "agent.error",
      code: "runtime_error",
      message: "missing session",
      recoverable: false,
      at: new Date().toISOString(),
    });

    await Promise.resolve();

    expect(getSessionByKey).not.toHaveBeenCalled();
    expect(setAssistantThreadStatus).not.toHaveBeenCalled();

    await service.stop();
  });

  it("persists normalized agent runtime events as agent trace events", async () => {
    const agentRuntime = new EventEmitter();
    const records: PersistedAgentTraceEvent[] = [];
    const upsertAgentTraceEvent = vi.fn(async (record: PersistedAgentTraceEvent) => {
      records.push(record);
    });

    const service = new SlackConversationService({
      config: TEST_CONFIG,
      sessions: {
        getSessionByKey: vi.fn(() => TEST_SESSION),
        upsertAgentTraceEvent,
      } as never,
      agentRuntime: agentRuntime as never,
      slackApi: {
        setAssistantThreadStatus: vi.fn(),
        addReaction: vi.fn(),
        removeReaction: vi.fn(),
      } as never,
      selfMessageFilter: {} as never,
    });

    agentRuntime.emit("event", {
      type: "agent.session.started",
      agentSessionId: TEST_SESSION.agentSessionId,
      brokerSessionKey: TEST_SESSION.key,
      systemPrompt: ["System instruction", "", "Personal long-lived memory from ~/.codex/AGENT.md:", "- remember the admin language", "", "Slack thread message model:", "live thread"].join("\n"),
      memory: "- remember the admin language",
      at: new Date().toISOString(),
    });
    agentRuntime.emit("event", {
      type: "agent.tool.started",
      agentSessionId: TEST_SESSION.agentSessionId,
      brokerSessionKey: TEST_SESSION.key,
      turnId: TEST_SESSION.activeTurnId,
      callId: "call-1",
      name: "exec_command",
      at: new Date().toISOString(),
    });

    await vi.waitFor(() => {
      expect(upsertAgentTraceEvent).toHaveBeenCalledTimes(3);
    });
    expect(records.map((record) => record.type)).toEqual(expect.arrayContaining(["agent_system_prompt", "agent_memory", "agent_tool_call"]));
    expect(records.find((record) => record.type === "agent_tool_call")).toEqual(
      expect.objectContaining({
        source: "agent_runtime",
        toolName: "exec_command",
      }),
    );

    await service.stop();
  });

  it("converts file upload initial comments from markdownish to mrkdwn", async () => {
    const agentRuntime = new EventEmitter();
    const uploadThreadFile = vi.fn(async () => ({
      fileId: "F123",
    }));
    const setLastSlackReplyAt = vi.fn(async () => TEST_SESSION);

    const service = new SlackConversationService({
      config: TEST_CONFIG,
      sessions: {
        setLastSlackReplyAt,
      } as never,
      agentRuntime: agentRuntime as never,
      slackApi: {
        uploadThreadFile,
        setAssistantThreadStatus: vi.fn(),
        addReaction: vi.fn(),
        removeReaction: vi.fn(),
      } as never,
      selfMessageFilter: {} as never,
    });

    await service.postSlackFile({
      channelId: "C123",
      rootThreadTs: "111.222",
      contentBase64: Buffer.from("hello world").toString("base64"),
      filename: "report.txt",
      initialComment: "## Summary\n- **done**\n- [docs](https://example.com)",
    });

    expect(uploadThreadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        initialComment: "*Summary*\n• *done*\n• <https://example.com|docs>",
      }),
    );
    expect(setLastSlackReplyAt).toHaveBeenCalledTimes(1);

    await service.stop();
  });

  it("records a silent stop state without owning active turn completion", async () => {
    const agentRuntime = new EventEmitter();
    const recordTurnSignal = vi.fn(async () => TEST_SESSION);
    const setActiveTurnId = vi.fn(async () => ({
      ...TEST_SESSION,
      activeTurnId: undefined,
    }));
    const listInboundMessages = vi.fn((): PersistedInboundMessage[] => []);

    const service = new SlackConversationService({
      config: TEST_CONFIG,
      sessions: {
        getSession: vi.fn(() => TEST_SESSION),
        recordTurnSignal,
        setActiveTurnId,
        listInboundMessages,
        updateInboundMessagesForBatch: vi.fn(async () => []),
        setLastDeliveredMessageTs: vi.fn(async () => TEST_SESSION),
      } as never,
      agentRuntime: agentRuntime as never,
      slackApi: {
        setAssistantThreadStatus: vi.fn(),
        addReaction: vi.fn(),
        removeReaction: vi.fn(),
      } as never,
      selfMessageFilter: {} as never,
    });

    await service.postSlackState({
      channelId: "C123",
      rootThreadTs: "111.222",
      kind: "wait",
      reason: "waiting on async job",
    });

    expect(recordTurnSignal).toHaveBeenCalledWith(
      "C123",
      "111.222",
      expect.objectContaining({
        turnId: "turn-1",
        kind: "wait",
        reason: "waiting on async job",
      }),
    );
    expect(setActiveTurnId).not.toHaveBeenCalled();
    expect(listInboundMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C123",
        rootThreadTs: "111.222",
        status: "inflight",
        batchId: "turn-1",
      }),
    );

    await service.stop();
  });

  it("records a visible final Slack message without owning active turn completion", async () => {
    const agentRuntime = new EventEmitter();
    const recordTurnSignal = vi.fn(async () => TEST_SESSION);
    const setActiveTurnId = vi.fn(async () => ({
      ...TEST_SESSION,
      activeTurnId: undefined,
    }));
    const postThreadMessage = vi.fn(async (_channelId: string, _threadTs: string, _text: string) => "333.444");
    const setLastSlackReplyAt = vi.fn(async () => TEST_SESSION);

    const service = new SlackConversationService({
      config: TEST_CONFIG,
      sessions: {
        recordTurnSignal,
        setActiveTurnId,
        setLastSlackReplyAt,
        listInboundMessages: vi.fn((): PersistedInboundMessage[] => []),
        updateInboundMessagesForBatch: vi.fn(async () => []),
        setLastDeliveredMessageTs: vi.fn(async () => TEST_SESSION),
      } as never,
      agentRuntime: agentRuntime as never,
      slackApi: {
        postThreadMessage,
        setAssistantThreadStatus: vi.fn(),
        addReaction: vi.fn(),
        removeReaction: vi.fn(),
      } as never,
      selfMessageFilter: {
        rememberPostedMessageTs: vi.fn(),
      } as never,
    });

    await service.postSlackMessage({
      channelId: "C123",
      rootThreadTs: "111.222",
      text: "done",
      kind: "final",
    });

    expect(postThreadMessage).toHaveBeenCalledTimes(1);
    expect(recordTurnSignal).toHaveBeenCalledWith(
      "C123",
      "111.222",
      expect.objectContaining({
        turnId: "turn-1",
        kind: "final",
      }),
    );
    expect(setActiveTurnId).not.toHaveBeenCalled();

    await service.stop();
  });

  it("stops missed-message recovery on Slack rate limit and backs off the next periodic scan", async () => {
    const agentRuntime = new EventEmitter();
    const sessions = [
      {
        ...TEST_SESSION,
        activeTurnId: undefined,
        lastObservedMessageTs: "111.223",
        updatedAt: new Date().toISOString(),
      },
      {
        ...TEST_SESSION,
        key: "C123:222.333",
        rootThreadTs: "222.333",
        activeTurnId: undefined,
        lastObservedMessageTs: "222.334",
        updatedAt: new Date().toISOString(),
      },
    ];
    const listThreadMessages = vi.fn(async () => {
      throw new SlackApiError({
        path: "conversations.replies",
        status: 429,
        statusText: "Too Many Requests",
        retryAfterMs: 120_000,
      });
    });

    const service = new SlackConversationService({
      config: {
        ...TEST_CONFIG,
        slackMissedThreadRecoveryIntervalMs: 100,
        slackActiveTurnReconcileIntervalMs: 100,
      } as AppConfig,
      sessions: {
        listSessions: vi.fn(() => sessions),
        getLatestSlackInboundMessageTs: vi.fn(),
      } as never,
      agentRuntime: agentRuntime as never,
      slackApi: {
        listThreadMessages,
        setAssistantThreadStatus: vi.fn(),
        addReaction: vi.fn(),
        removeReaction: vi.fn(),
      } as never,
      selfMessageFilter: {
        shouldIgnoreThreadMessage: vi.fn(() => false),
      } as never,
    });

    await service.recoverMissedThreadMessages("periodic");
    await service.recoverMissedThreadMessages("periodic");

    expect(listThreadMessages).toHaveBeenCalledTimes(1);
    expect(listThreadMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C123",
        rootThreadTs: "111.222",
      }),
    );

    await service.stop();
  });
});
