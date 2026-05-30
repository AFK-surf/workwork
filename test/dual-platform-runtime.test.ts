import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { configureLogger, flushLogger } from "../src/logger.js";
import { FeishuCodexBridge } from "../src/services/feishu/feishu-codex-bridge.js";
import { FeishuPlatformAdapter } from "../src/services/feishu/feishu-platform-adapter.js";
import { GitHubAuthorMappingService } from "../src/services/github-author-mapping-service.js";
import { SessionManager } from "../src/services/session-manager.js";
import { SlackCodexBridge } from "../src/services/slack/slack-codex-bridge.js";
import { StateStore } from "../src/store/state-store.js";
import { MockSlackServer } from "./manual/mock-slack-server.js";

describe("dual-platform runtime", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("starts Slack Socket Mode and a real Feishu bridge in one broker runtime", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dual-platform-runtime-"));
    cleanups.push(async () => {
      await fs.rm(tempRoot, {
        recursive: true,
        force: true
      });
    });

    const mockSlack = new MockSlackServer("UBOT", {
      botId: "BBOT",
      appId: "AAPP"
    });
    const slackPort = await mockSlack.start();
    cleanups.push(async () => {
      await mockSlack.stop();
    });

    configureLogger({
      logDir: path.join(tempRoot, "logs"),
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false
    });

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_API_BASE_URL: `http://127.0.0.1:${slackPort}/api`,
      SLACK_SOCKET_OPEN_URL: "apps.connections.open",
      FEISHU_ENABLED: "true",
      FEISHU_APP_ID: "cli-test",
      FEISHU_APP_SECRET: "secret-test",
      FEISHU_BOT_OPEN_ID: "ou_bot",
      FEISHU_GROUP_MESSAGE_MODE: "all",
      FEISHU_STARTUP_REQUIRED: "true",
      STATE_DIR: path.join(tempRoot, "state"),
      SESSIONS_ROOT: path.join(tempRoot, "sessions"),
      REPOS_ROOT: path.join(tempRoot, "repos"),
      JOBS_ROOT: path.join(tempRoot, "jobs"),
      CODEX_HOME: path.join(tempRoot, "codex-home")
    } as NodeJS.ProcessEnv);
    const sessions = new SessionManager({
      stateStore: new StateStore(config.stateDir, config.sessionsRoot),
      sessionsRoot: config.sessionsRoot
    });
    const mappings = new GitHubAuthorMappingService({
      stateDir: config.stateDir
    });
    await mappings.load();

    const codexEvents = new EventEmitter();
    let turnCounter = 0;
    const completeTurns: Array<() => void> = [];
    const codex = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      setSlackBotIdentity: vi.fn(),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        codexEvents.on(event, listener);
      }),
      off: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        codexEvents.off(event, listener);
      }),
      ensureThread: vi.fn(async () => "codex-thread-slack"),
      startTurn: vi.fn(async () => {
        turnCounter += 1;
        const turnId = `turn-${turnCounter}`;
        const completion = new Promise((resolve) => {
          completeTurns.push(() => {
            resolve({
              turnId,
              finalMessage: "",
              aborted: false
            });
          });
        });
        return {
          turnId,
          completion
        };
      }),
      steer: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
      readTurnResult: vi.fn(async () => null)
    };
    const feishuWsClient = new FakeFeishuWsClient();
    const feishuBridge = new FeishuCodexBridge({
      sessions,
      codex: codex as never,
      groupMessageMode: "all",
      mappings,
      adapter: new FeishuPlatformAdapter({
        appId: config.feishuAppId!,
        appSecret: config.feishuAppSecret!,
        apiBaseUrl: config.feishuApiBaseUrl,
        api: createFakeFeishuApi(),
        wsClient: feishuWsClient,
        botIdentity: {
          openId: config.feishuBotOpenId
        },
        groupMessageMode: config.feishuGroupMessageMode,
        startupRequired: config.feishuStartupRequired
      })
    });
    const bridge = new SlackCodexBridge({
      config,
      sessions,
      codex: codex as never,
      mappings,
      feishuBridge
    });
    cleanups.push(async () => {
      await bridge.stop();
    });

    await bridge.start();
    await mockSlack.waitForSocket();
    await mockSlack.sendEvent("evt-dual-slack-mention", {
      type: "app_mention",
      user: "U123",
      channel: "C123",
      thread_ts: "220.330",
      ts: "220.331",
      text: "<@UBOT> dual runtime check"
    });
    await waitForCondition(() => codex.startTurn.mock.calls.length === 1, "Slack turn start");
    await bridge.postChatMessage({
      platform: "slack",
      conversationId: "C123",
      rootMessageId: "220.330",
      text: "DUAL_SLACK_REPLY_OK",
      kind: "final"
    });
    await mockSlack.waitForPostedMessage((message) => (
      message.channel === "C123" &&
      message.threadTs === "220.330" &&
      message.text === "DUAL_SLACK_REPLY_OK"
    ));
    completeTurns.shift()?.();
    await waitForCondition(
      () => sessions.getSession("C123", "220.330")?.activeTurnId === undefined,
      "Slack turn completion"
    );

    expect(codex.start).toHaveBeenCalledTimes(1);
    expect(codex.setSlackBotIdentity).toHaveBeenCalledTimes(1);
    expect(codex.startTurn).toHaveBeenCalledTimes(1);
    expect(feishuWsClient.started).toBe(true);
    await flushLogger();
    const logRecords = await readJsonl(path.join(tempRoot, "logs", "broker.jsonl"));
    expect(logRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.platform.ready",
          meta: expect.objectContaining({
            platform: "feishu",
            source: "long_connection",
            groupMessageMode: "all"
          })
        }),
        expect.objectContaining({
          message: "chat.platform.ready",
          meta: expect.objectContaining({
            platform: "slack",
            source: "socket_mode"
          })
        }),
        expect.objectContaining({
          message: "chat.message.accepted",
          meta: expect.objectContaining({
            platform: "slack",
            sessionKey: "C123:220.330",
            conversationId: "C123",
            rootMessageId: "220.330",
            messageId: "220.331"
          })
        }),
        expect.objectContaining({
          message: "chat.outbound.posted",
          meta: expect.objectContaining({
            platform: "slack",
            sessionKey: "C123:220.330",
            conversationId: "C123",
            rootMessageId: "220.330",
            format: "text"
          })
        }),
        expect.objectContaining({
          message: "chat.platform.degraded",
          meta: expect.objectContaining({
            platform: "feishu",
            groupMessageMode: "all",
            degradedReason: "all_message_delivery_unverified",
            permission: "im:message.group_msg"
          })
        })
      ])
    );
  });

  it("keeps Slack ready when optional Feishu startup degrades", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dual-platform-runtime-feishu-degraded-"));
    cleanups.push(async () => {
      await fs.rm(tempRoot, {
        recursive: true,
        force: true
      });
    });

    const mockSlack = new MockSlackServer("UBOT", {
      botId: "BBOT",
      appId: "AAPP"
    });
    const slackPort = await mockSlack.start();
    cleanups.push(async () => {
      await mockSlack.stop();
    });

    configureLogger({
      logDir: path.join(tempRoot, "logs"),
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false
    });

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_API_BASE_URL: `http://127.0.0.1:${slackPort}/api`,
      SLACK_SOCKET_OPEN_URL: "apps.connections.open",
      FEISHU_ENABLED: "true",
      FEISHU_APP_ID: "cli-test",
      FEISHU_APP_SECRET: "secret-test",
      FEISHU_BOT_OPEN_ID: "ou_bot",
      FEISHU_GROUP_MESSAGE_MODE: "all",
      FEISHU_STARTUP_REQUIRED: "false",
      STATE_DIR: path.join(tempRoot, "state"),
      SESSIONS_ROOT: path.join(tempRoot, "sessions"),
      REPOS_ROOT: path.join(tempRoot, "repos"),
      JOBS_ROOT: path.join(tempRoot, "jobs"),
      CODEX_HOME: path.join(tempRoot, "codex-home")
    } as NodeJS.ProcessEnv);
    const sessions = new SessionManager({
      stateStore: new StateStore(config.stateDir, config.sessionsRoot),
      sessionsRoot: config.sessionsRoot
    });
    const mappings = new GitHubAuthorMappingService({
      stateDir: config.stateDir
    });
    await mappings.load();

    const codex = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      setSlackBotIdentity: vi.fn(),
      on: vi.fn(),
      off: vi.fn()
    };
    const feishuWsClient = new FailingFeishuWsClient();
    const feishuBridge = new FeishuCodexBridge({
      sessions,
      codex: codex as never,
      groupMessageMode: "all",
      mappings,
      adapter: new FeishuPlatformAdapter({
        appId: config.feishuAppId!,
        appSecret: config.feishuAppSecret!,
        apiBaseUrl: config.feishuApiBaseUrl,
        api: createFakeFeishuApi(),
        wsClient: feishuWsClient,
        botIdentity: {
          openId: config.feishuBotOpenId
        },
        groupMessageMode: config.feishuGroupMessageMode,
        startupRequired: config.feishuStartupRequired
      })
    });
    const bridge = new SlackCodexBridge({
      config,
      sessions,
      codex: codex as never,
      mappings,
      feishuBridge
    });
    cleanups.push(async () => {
      await bridge.stop();
    });

    await bridge.start();
    await mockSlack.waitForSocket();

    expect(feishuWsClient.startAttempts).toBe(1);
    expect(codex.start).toHaveBeenCalledTimes(1);
    await flushLogger();
    const logRecords = await readJsonl(path.join(tempRoot, "logs", "broker.jsonl"));
    expect(logRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.platform.degraded",
          meta: expect.objectContaining({
            platform: "feishu",
            source: "long_connection",
            groupMessageMode: "all",
            startupRequired: false,
            degradedReason: "startup_failed",
            errorClass: "Error"
          })
        }),
        expect.objectContaining({
          message: "chat.platform.ready",
          meta: expect.objectContaining({
            platform: "slack",
            source: "socket_mode"
          })
        })
      ])
    );
  });

  it("reports at_only as degraded after Feishu long connection starts", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dual-platform-runtime-feishu-at-only-"));
    cleanups.push(async () => {
      await fs.rm(tempRoot, {
        recursive: true,
        force: true
      });
    });

    const mockSlack = new MockSlackServer("UBOT", {
      botId: "BBOT",
      appId: "AAPP"
    });
    const slackPort = await mockSlack.start();
    cleanups.push(async () => {
      await mockSlack.stop();
    });

    configureLogger({
      logDir: path.join(tempRoot, "logs"),
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false
    });

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_API_BASE_URL: `http://127.0.0.1:${slackPort}/api`,
      SLACK_SOCKET_OPEN_URL: "apps.connections.open",
      FEISHU_ENABLED: "true",
      FEISHU_APP_ID: "cli-test",
      FEISHU_APP_SECRET: "secret-test",
      FEISHU_BOT_OPEN_ID: "ou_bot",
      FEISHU_GROUP_MESSAGE_MODE: "at_only",
      FEISHU_STARTUP_REQUIRED: "false",
      STATE_DIR: path.join(tempRoot, "state"),
      SESSIONS_ROOT: path.join(tempRoot, "sessions"),
      REPOS_ROOT: path.join(tempRoot, "repos"),
      JOBS_ROOT: path.join(tempRoot, "jobs"),
      CODEX_HOME: path.join(tempRoot, "codex-home")
    } as NodeJS.ProcessEnv);
    const sessions = new SessionManager({
      stateStore: new StateStore(config.stateDir, config.sessionsRoot),
      sessionsRoot: config.sessionsRoot
    });
    const mappings = new GitHubAuthorMappingService({
      stateDir: config.stateDir
    });
    await mappings.load();

    const codex = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      setSlackBotIdentity: vi.fn(),
      on: vi.fn(),
      off: vi.fn()
    };
    const feishuWsClient = new FakeFeishuWsClient();
    const feishuBridge = new FeishuCodexBridge({
      sessions,
      codex: codex as never,
      groupMessageMode: "at_only",
      mappings,
      adapter: new FeishuPlatformAdapter({
        appId: config.feishuAppId!,
        appSecret: config.feishuAppSecret!,
        apiBaseUrl: config.feishuApiBaseUrl,
        api: createFakeFeishuApi(),
        wsClient: feishuWsClient,
        botIdentity: {
          openId: config.feishuBotOpenId
        },
        groupMessageMode: config.feishuGroupMessageMode,
        startupRequired: config.feishuStartupRequired
      })
    });
    const bridge = new SlackCodexBridge({
      config,
      sessions,
      codex: codex as never,
      mappings,
      feishuBridge
    });
    cleanups.push(async () => {
      await bridge.stop();
    });

    await bridge.start();
    await mockSlack.waitForSocket();

    expect(feishuWsClient.started).toBe(true);
    await flushLogger();
    const logRecords = await readJsonl(path.join(tempRoot, "logs", "broker.jsonl"));
    expect(logRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.platform.degraded",
          meta: expect.objectContaining({
            platform: "feishu",
            source: "long_connection",
            groupMessageMode: "at_only",
            startupRequired: false,
            degradedReason: "group_message_all_unavailable",
            permission: "im:message.group_msg"
          })
        }),
        expect.objectContaining({
          message: "chat.platform.ready",
          meta: expect.objectContaining({
            platform: "slack",
            source: "socket_mode"
          })
        })
      ])
    );
  });

  it("fails fast before Slack Socket Mode when required Feishu startup fails", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dual-platform-runtime-feishu-required-"));
    cleanups.push(async () => {
      await fs.rm(tempRoot, {
        recursive: true,
        force: true
      });
    });

    const mockSlack = new MockSlackServer("UBOT", {
      botId: "BBOT",
      appId: "AAPP"
    });
    const slackPort = await mockSlack.start();
    cleanups.push(async () => {
      await mockSlack.stop();
    });

    configureLogger({
      logDir: path.join(tempRoot, "logs"),
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false
    });

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_API_BASE_URL: `http://127.0.0.1:${slackPort}/api`,
      SLACK_SOCKET_OPEN_URL: "apps.connections.open",
      FEISHU_ENABLED: "true",
      FEISHU_APP_ID: "cli-test",
      FEISHU_APP_SECRET: "secret-test",
      FEISHU_BOT_OPEN_ID: "ou_bot",
      FEISHU_GROUP_MESSAGE_MODE: "all",
      FEISHU_STARTUP_REQUIRED: "true",
      STATE_DIR: path.join(tempRoot, "state"),
      SESSIONS_ROOT: path.join(tempRoot, "sessions"),
      REPOS_ROOT: path.join(tempRoot, "repos"),
      JOBS_ROOT: path.join(tempRoot, "jobs"),
      CODEX_HOME: path.join(tempRoot, "codex-home")
    } as NodeJS.ProcessEnv);
    const sessions = new SessionManager({
      stateStore: new StateStore(config.stateDir, config.sessionsRoot),
      sessionsRoot: config.sessionsRoot
    });
    const mappings = new GitHubAuthorMappingService({
      stateDir: config.stateDir
    });
    await mappings.load();

    const codex = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      setSlackBotIdentity: vi.fn(),
      on: vi.fn(),
      off: vi.fn()
    };
    const feishuWsClient = new FailingFeishuWsClient();
    const feishuBridge = new FeishuCodexBridge({
      sessions,
      codex: codex as never,
      groupMessageMode: "all",
      mappings,
      adapter: new FeishuPlatformAdapter({
        appId: config.feishuAppId!,
        appSecret: config.feishuAppSecret!,
        apiBaseUrl: config.feishuApiBaseUrl,
        api: createFakeFeishuApi(),
        wsClient: feishuWsClient,
        botIdentity: {
          openId: config.feishuBotOpenId
        },
        groupMessageMode: config.feishuGroupMessageMode,
        startupRequired: config.feishuStartupRequired
      })
    });
    const bridge = new SlackCodexBridge({
      config,
      sessions,
      codex: codex as never,
      mappings,
      feishuBridge
    });
    cleanups.push(async () => {
      await bridge.stop();
    });

    await expect(bridge.start()).rejects.toThrow("long connection unavailable");

    expect(feishuWsClient.startAttempts).toBe(1);
    expect(codex.start).toHaveBeenCalledTimes(1);
    await flushLogger();
    const logRecords = await readJsonl(path.join(tempRoot, "logs", "broker.jsonl"));
    expect(logRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.platform.degraded",
          meta: expect.objectContaining({
            platform: "feishu",
            source: "long_connection",
            groupMessageMode: "all",
            startupRequired: true,
            degradedReason: "startup_failed",
            errorClass: "Error"
          })
        })
      ])
    );
    expect(logRecords).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.platform.starting",
          meta: expect.objectContaining({
            platform: "slack",
            source: "socket_mode"
          })
        }),
        expect.objectContaining({
          message: "chat.platform.ready",
          meta: expect.objectContaining({
            platform: "slack",
            source: "socket_mode"
          })
        })
      ])
    );
  });
});

class FakeFeishuWsClient {
  started = false;
  closed = false;

  async start(): Promise<void> {
    this.started = true;
  }

  close(): void {
    this.closed = true;
  }
}

class FailingFeishuWsClient {
  startAttempts = 0;
  closed = false;

  async start(): Promise<void> {
    this.startAttempts += 1;
    throw new Error("long connection unavailable");
  }

  close(): void {
    this.closed = true;
  }
}

function createFakeFeishuApi() {
  return {
    listMessages: async () => ({
      has_more: false,
      items: []
    }),
    replyMessage: async () => ({
      message_id: "om_reply"
    }),
    uploadMessageImage: async () => ({
      image_key: "img_uploaded"
    }),
    uploadMessageFile: async () => ({
      file_key: "file_uploaded"
    }),
    downloadMessageResourceAsDataUrl: async () => "data:text/plain;base64,aGVsbG8="
  } as any;
}

async function readJsonl(filePath: string): Promise<unknown[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
}

async function waitForCondition(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for ${label}`);
}
