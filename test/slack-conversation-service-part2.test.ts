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

describe("SlackConversationService", () => {
  it("resets a session by dropping the old agent history and dispatching a fresh Slack-context wakeup", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-conversation-reset-state-"));
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-conversation-reset-sessions-"));
    const stateStore = new StateStore(stateDir, sessionsRoot);
    const sessions = new SessionManager({
      stateStore,
      sessionsRoot,
    });
    await sessions.load();
    let session = await sessions.ensureSession("C123", "111.222", {
      channelName: "bridge-app",
      channelType: "channel",
    });
    session = await sessions.setAgentSessionId(session.channelId, session.rootThreadTs, "thread-old");
    session = await sessions.setActiveTurnId(session.channelId, session.rootThreadTs, "turn-old");
    await sessions.upsertInboundMessage({
      key: `${session.key}:111.223`,
      sessionKey: session.key,
      channelId: session.channelId,
      channelType: session.channelType,
      rootThreadTs: session.rootThreadTs,
      messageTs: "111.223",
      source: "thread_reply",
      userId: "U123",
      text: "old pending",
      status: "pending",
      createdAt: "2026-03-19T00:00:01.000Z",
      updatedAt: "2026-03-19T00:00:01.000Z",
    });
    await sessions.upsertInboundMessage({
      key: `${session.key}:111.224`,
      sessionKey: session.key,
      channelId: session.channelId,
      channelType: session.channelType,
      rootThreadTs: session.rootThreadTs,
      messageTs: "111.224",
      source: "thread_reply",
      userId: "U123",
      text: "old inflight",
      status: "inflight",
      batchId: "turn-old",
      createdAt: "2026-03-19T00:00:02.000Z",
      updatedAt: "2026-03-19T00:00:02.000Z",
    });

    let submittedText = "";
    const agentRuntime = Object.assign(new EventEmitter(), {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      setSlackBotIdentity: vi.fn(),
      getCapabilities: vi.fn(),
      ensureSession: vi.fn(async (nextSession: SlackSessionRecord) => {
        expect(nextSession.agentSessionId).toBeUndefined();
        expect(nextSession.activeTurnId).toBeUndefined();
        return {
          id: "thread-new",
          brokerSessionKey: nextSession.key,
          runtime: "test",
          createdAt: "2026-03-19T00:00:03.000Z",
        };
      }),
      submitInput: vi.fn(async (input: { readonly input: readonly { readonly type: string; readonly text?: string }[]; readonly inputId: string }) => {
        submittedText = input.input.find((item) => item.type === "text")?.text ?? "";
        return {
          receipt: {
            agentSessionId: "thread-new",
            turnId: "turn-new",
            inputId: input.inputId,
            delivery: "started_turn" as const,
            deliveredAt: "2026-03-19T00:00:04.000Z",
          },
          completion: Promise.resolve({
            agentSessionId: "thread-new",
            turnId: "turn-new",
            finalMessage: "",
            aborted: true,
          }),
        };
      }),
      interrupt: vi.fn(async () => undefined),
      readSession: vi.fn(),
      readTurn: vi.fn(),
    });
    const listThreadMessages = vi.fn(async () => [
      {
        channelId: "C123",
        channelType: "channel",
        rootThreadTs: "111.222",
        messageTs: "111.222",
        userId: "U111",
        text: "原始需求",
        senderKind: "user" as const,
      },
      {
        channelId: "C123",
        channelType: "channel",
        rootThreadTs: "111.222",
        messageTs: "111.225",
        userId: "U222",
        text: "最新补充",
        senderKind: "user" as const,
      },
    ]);

    const service = new SlackConversationService({
      config: TEST_CONFIG,
      sessions,
      agentRuntime: agentRuntime as never,
      slackApi: {
        listThreadMessages,
        postThreadMessage: vi.fn(async () => "333.444"),
        setAssistantThreadStatus: vi.fn(),
        addReaction: vi.fn(),
        removeReaction: vi.fn(),
        getUserIdentity: vi.fn(async (userId: string) => ({
          userId,
          mention: `<@${userId}>`,
          displayName: userId === "U222" ? "用户二" : "用户一",
        })),
        downloadImageAsDataUrl: vi.fn(),
      } as never,
      selfMessageFilter: {
        rememberPostedMessageTs: vi.fn(),
        shouldIgnoreThreadMessage: vi.fn(() => false),
      } as never,
    });

    const reset = await service.resetSession(session.key);
    await vi.waitFor(() => {
      expect(agentRuntime.submitInput).toHaveBeenCalledTimes(1);
    });

    expect(reset).toMatchObject({
      clearedInboundCount: 2,
      resumedCount: 1,
      interruptedActiveTurn: true,
      previousAgentSessionId: "thread-old",
      previousActiveTurnId: "turn-old",
      historyMessageCount: 2,
      authBlocked: false,
    });
    expect(agentRuntime.interrupt).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionId: "thread-old",
        activeTurnId: "turn-old",
      }),
    );
    expect(submittedText).toContain("previous agent thread/history was intentionally discarded");
    expect(submittedText).toContain("原始需求");
    expect(submittedText).toContain("最新补充");

    const latest = sessions.getSessionByKey(session.key);
    expect(latest).toMatchObject({
      agentSessionId: "thread-new",
      activeTurnId: undefined,
    });
    expect(
      sessions.listInboundMessages({
        channelId: session.channelId,
        rootThreadTs: session.rootThreadTs,
        status: ["pending", "inflight"],
      }),
    ).toHaveLength(0);
    const resetMessage = sessions.listInboundMessages({
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      source: "admin_session_reset",
    })[0];
    expect(resetMessage).toMatchObject({
      messageTs: reset.resetMessageTs,
      status: "done",
      text: expect.stringContaining("丢弃旧 agent history"),
    });
    expect(sessions.listAgentTraceEvents(session.key)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agent_session_reset",
          title: "Session 已重置",
          summary: "已清空 agent history 并重新唤起 bot",
        }),
      ]),
    );

    await service.stop();
    stateStore.close();
    await fs.rm(stateDir, { force: true, recursive: true });
    await fs.rm(sessionsRoot, { force: true, recursive: true });
  });

  it("deletes a session without ensuring a new agent session first", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-conversation-delete-state-"));
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-conversation-delete-sessions-"));
    const stateStore = new StateStore(stateDir, sessionsRoot);
    const sessions = new SessionManager({
      stateStore,
      sessionsRoot,
    });
    await sessions.load();
    let session = await sessions.ensureSession("C123", "111.222");
    session = await sessions.setAgentSessionId(session.channelId, session.rootThreadTs, "thread-old");
    session = await sessions.setActiveTurnId(session.channelId, session.rootThreadTs, "turn-old");

    const agentRuntime = Object.assign(new EventEmitter(), {
      ensureSession: vi.fn(async () => {
        throw new Error("delete should not ensure a replacement session");
      }),
      interrupt: vi.fn(async () => undefined),
      readSession: vi.fn(),
      readTurn: vi.fn(),
    });
    const setAssistantThreadStatus = vi.fn(async () => undefined);
    const service = new SlackConversationService({
      config: TEST_CONFIG,
      sessions,
      agentRuntime: agentRuntime as never,
      slackApi: {
        setAssistantThreadStatus,
        addReaction: vi.fn(),
        removeReaction: vi.fn(),
      } as never,
      selfMessageFilter: {} as never,
    });

    const deleted = await service.deleteSession(session.key);

    expect(deleted).toMatchObject({
      deleted: true,
      interruptedActiveTurn: true,
      previousAgentSessionId: "thread-old",
      previousActiveTurnId: "turn-old",
      clearedInboundCount: 0,
    });
    expect(agentRuntime.ensureSession).not.toHaveBeenCalled();
    expect(agentRuntime.interrupt).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionId: "thread-old",
        activeTurnId: "turn-old",
      }),
    );
    expect(sessions.getSessionByKey(session.key)).toBeUndefined();

    await service.stop();
    stateStore.close();
    await fs.rm(stateDir, { force: true, recursive: true });
    await fs.rm(sessionsRoot, { force: true, recursive: true });
  });

  it("keeps Slack input pending and posts one session link when auth profile is unavailable", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-conversation-auth-block-state-"));
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-conversation-auth-block-sessions-"));
    const stateStore = new StateStore(stateDir, sessionsRoot);
    const sessions = new SessionManager({
      stateStore,
      sessionsRoot,
    });
    await sessions.load();
    let session = await sessions.ensureSession("C123", "111.222");
    session = await sessions.setSessionAuthProfile(session.key, "empty-profile", {
      boundAt: "2026-05-09T00:00:00.000Z",
    });
    const agentRuntime = Object.assign(new EventEmitter(), {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      setSlackBotIdentity: vi.fn(),
      getCapabilities: vi.fn(),
      ensureSession: vi.fn(async () => {
        throw new AuthProfileUnavailableError({
          sessionKey: session.key,
          profileName: "empty-profile",
          reason: "primary_quota_exhausted",
        });
      }),
      submitInput: vi.fn(),
      interrupt: vi.fn(),
      readSession: vi.fn(),
      readTurn: vi.fn(),
    });
    const postThreadMessage = vi.fn(async () => "333.444");

    const service = new SlackConversationService({
      config: TEST_CONFIG,
      sessions,
      agentRuntime: agentRuntime as never,
      slackApi: {
        postThreadMessage,
        setAssistantThreadStatus: vi.fn(),
        addReaction: vi.fn(),
        removeReaction: vi.fn(),
        getUserIdentity: vi.fn(async () => null),
      } as never,
      selfMessageFilter: {
        rememberPostedMessageTs: vi.fn(),
        shouldIgnoreThreadMessage: vi.fn(() => false),
      } as never,
    });

    await service.acceptInboundMessage(session, {
      source: "thread_reply",
      channelId: "C123",
      rootThreadTs: "111.222",
      messageTs: "111.223",
      userId: "U123",
      text: "继续",
    });

    await vi.waitFor(() => {
      expect(postThreadMessage).toHaveBeenCalledTimes(2);
    });
    const postCalls = postThreadMessage.mock.calls as unknown as Array<[string, string, string]>;
    expect(postCalls[0]).toEqual(["C123", "111.222", "<https://admin.example/admin/sessions/C123%3A111.222|查看会话活动时间线>"]);
    expect(postCalls[1]?.[2]).toContain("账号额度不可用");
    expect(postCalls[1]?.[2]).toContain("https://admin.example/admin/sessions/C123%3A111.222");

    expect(
      sessions.listInboundMessages({
        channelId: session.channelId,
        rootThreadTs: session.rootThreadTs,
        status: "pending",
      }),
    ).toHaveLength(1);
    expect(sessions.getSessionByKey(session.key)).toMatchObject({
      authProfileName: "empty-profile",
      authBlockReason: "primary_quota_exhausted",
      authBlockedNoticePostedAt: expect.any(String),
    });

    await service.acceptInboundMessage(sessions.getSessionByKey(session.key)!, {
      source: "thread_reply",
      channelId: "C123",
      rootThreadTs: "111.222",
      messageTs: "111.224",
      userId: "U123",
      text: "再发一条",
    });
    await vi.waitFor(() => {
      expect(agentRuntime.ensureSession).toHaveBeenCalledTimes(2);
    });
    expect(postThreadMessage).toHaveBeenCalledTimes(2);

    await service.stop();
    stateStore.close();
    await fs.rm(stateDir, { force: true, recursive: true });
    await fs.rm(sessionsRoot, { force: true, recursive: true });
  });

  it("keeps Slack input pending without asking for manual switch when auth profile status reads fail", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-conversation-auth-probe-state-"));
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-conversation-auth-probe-sessions-"));
    const stateStore = new StateStore(stateDir, sessionsRoot);
    const sessions = new SessionManager({
      stateStore,
      sessionsRoot,
    });
    await sessions.load();
    let session = await sessions.ensureSession("C123", "111.222");
    session = await sessions.setSessionAuthProfile(session.key, "bound-profile", {
      boundAt: "2026-05-09T00:00:00.000Z",
    });
    const agentRuntime = Object.assign(new EventEmitter(), {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      setSlackBotIdentity: vi.fn(),
      getCapabilities: vi.fn(),
      ensureSession: vi.fn(async () => {
        throw new AuthProfileUnavailableError({
          sessionKey: session.key,
          profileName: "bound-profile",
          reason: "account_probe_failed",
        });
      }),
      submitInput: vi.fn(),
      interrupt: vi.fn(),
      readSession: vi.fn(),
      readTurn: vi.fn(),
    });
    const postThreadMessage = vi.fn(async () => "333.444");

    const service = new SlackConversationService({
      config: TEST_CONFIG,
      sessions,
      agentRuntime: agentRuntime as never,
      slackApi: {
        postThreadMessage,
        setAssistantThreadStatus: vi.fn(),
        addReaction: vi.fn(),
        removeReaction: vi.fn(),
        getUserIdentity: vi.fn(async () => null),
      } as never,
      selfMessageFilter: {
        rememberPostedMessageTs: vi.fn(),
        shouldIgnoreThreadMessage: vi.fn(() => false),
      } as never,
    });

    await service.acceptInboundMessage(session, {
      source: "thread_reply",
      channelId: "C123",
      rootThreadTs: "111.222",
      messageTs: "111.223",
      userId: "U123",
      text: "继续",
    });

    await vi.waitFor(() => {
      expect(agentRuntime.ensureSession).toHaveBeenCalledTimes(1);
    });
    const postedTexts = (postThreadMessage.mock.calls as unknown as Array<[string, string, string]>).map((call) => String(call[2] ?? ""));
    expect(postedTexts.some((text) => text.includes("账号额度不可用"))).toBe(false);
    expect(postedTexts.some((text) => text.includes("手动切换账号"))).toBe(false);
    expect(
      sessions.listInboundMessages({
        channelId: session.channelId,
        rootThreadTs: session.rootThreadTs,
        status: "pending",
      }),
    ).toHaveLength(1);
    expect(sessions.getSessionByKey(session.key)).toMatchObject({
      authProfileName: "bound-profile",
      authBlockedAt: undefined,
      authBlockReason: undefined,
      authBlockedNoticePostedAt: undefined,
    });

    await service.stop();
    stateStore.close();
    await fs.rm(stateDir, { force: true, recursive: true });
    await fs.rm(sessionsRoot, { force: true, recursive: true });
  });
});
