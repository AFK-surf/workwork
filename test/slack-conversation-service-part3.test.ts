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
  it("posts the session activity link once when two inbound messages race", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-conversation-session-link-race-state-"));
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-conversation-session-link-race-sessions-"));
    const stateStore = new StateStore(stateDir, sessionsRoot);
    const sessions = new SessionManager({
      stateStore,
      sessionsRoot,
    });
    await sessions.load();
    const session = await sessions.ensureSession("C123", "111.222");
    const agentRuntime = Object.assign(new EventEmitter(), {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      setSlackBotIdentity: vi.fn(),
      getCapabilities: vi.fn(),
      ensureSession: vi.fn(async () => ({
        id: "agent-session-1",
        brokerSessionKey: session.key,
        runtime: "test",
        createdAt: "2026-05-09T00:00:00.000Z",
      })),
      submitInput: vi.fn(async (input: { readonly inputId: string }) => ({
        receipt: {
          agentSessionId: "agent-session-1",
          turnId: `turn-${input.inputId}`,
          inputId: input.inputId,
          delivery: "started_turn",
          deliveredAt: "2026-05-09T00:00:00.000Z",
        },
        completion: Promise.resolve({
          agentSessionId: "agent-session-1",
          turnId: `turn-${input.inputId}`,
          finalMessage: "",
          aborted: false,
        }),
      })),
      interrupt: vi.fn(),
      readSession: vi.fn(),
      readTurn: vi.fn(),
    });
    const postThreadMessage = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return `link-${postThreadMessage.mock.calls.length}`;
    });

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

    await Promise.all([
      service.acceptInboundMessage(session, {
        source: "thread_reply",
        channelId: "C123",
        rootThreadTs: "111.222",
        messageTs: "111.223",
        userId: "U123",
        text: "第一条",
      }),
      service.acceptInboundMessage(session, {
        source: "thread_reply",
        channelId: "C123",
        rootThreadTs: "111.222",
        messageTs: "111.224",
        userId: "U123",
        text: "第二条",
      }),
    ]);

    const linkPosts = (postThreadMessage.mock.calls as unknown as Array<[string, string, string]>).filter((call) => call[2].includes("查看会话活动时间线"));
    expect(linkPosts).toHaveLength(1);
    expect(sessions.getSessionByKey(session.key)).toMatchObject({
      sessionPageLinkPostedAt: expect.any(String),
    });
    await vi.waitFor(() => {
      expect(agentRuntime.submitInput.mock.calls.length).toBeGreaterThan(0);
      expect(
        sessions.listInboundMessages({
          channelId: session.channelId,
          rootThreadTs: session.rootThreadTs,
          status: "done",
        }).length,
      ).toBeGreaterThan(0);
    });

    await service.stop();
    stateStore.close();
    await fs.rm(stateDir, { force: true, recursive: true });
    await fs.rm(sessionsRoot, { force: true, recursive: true });
  });
});
