import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { routeFeishuReceiveMessageEvent, type FeishuBotIdentity } from "../src/services/feishu/feishu-event-parser.js";
import { FeishuPlatformAdapter } from "../src/services/feishu/feishu-platform-adapter.js";
import { configureLogger, flushLogger } from "../src/logger.js";

const receiveMessageFixtures = ["group-at-text", "private-text", "group-app-self-message", "group-followup-text", "group-followup-parent-only", "group-rich-post", "group-interactive-card", "group-image", "group-file", "duplicate-message"];

const cardActionFixtures = ["card-action-trigger", "card-action-skip"];

const rfcFixtureNames = [...receiveMessageFixtures, ...cardActionFixtures, "history-page"];
const implementationDocPath = path.join(process.cwd(), "docs", "rfcs", "0001-slack-feishu-dual-platform", "implementation.md");

interface FeishuReplayFixture {
  readonly raw: unknown;
  readonly botIdentity?: FeishuBotIdentity | undefined;
  readonly expected: {
    readonly route: "bot_mention" | "thread_reply" | "group_message" | "ignored" | "card_action" | "history_page";
    readonly ignoredReason?: string | undefined;
    readonly ignored?: Record<string, unknown> | undefined;
    readonly input?: Record<string, unknown> | undefined;
    readonly callback?: Record<string, unknown> | undefined;
    readonly messages?: readonly Record<string, unknown>[] | undefined;
    readonly logEvents: readonly string[];
  };
}

describe("Feishu fixture replay", () => {
  it("keeps the replay fixture list synchronized with the RFC fixture contract", async () => {
    const implementation = await fs.readFile(implementationDocPath, "utf8");
    const documentedFixtureNames = extractRequiredFixtureNames(implementation);

    expect(documentedFixtureNames).toEqual([...rfcFixtureNames].sort());
  });

  it.each(rfcFixtureNames)("keeps the RFC fixture %s present", async (name) => {
    await expect(fs.stat(fixturePath(name))).resolves.toMatchObject({
      isFile: expect.any(Function),
    });
  });

  it.each(rfcFixtureNames)("keeps the RFC fixture %s self-describing", async (name) => {
    const fixture = await loadFixture(name);

    expect(fixture.raw).toBeDefined();
    expect(fixture.expected.route).toBeTruthy();
    expect(fixture.expected.logEvents.length).toBeGreaterThan(0);

    if (fixture.expected.route === "ignored") {
      expect(fixture.expected.ignoredReason).toBeTruthy();
    } else if (fixture.expected.route === "card_action") {
      expect(fixture.expected.callback).toBeDefined();
    } else if (fixture.expected.route === "history_page") {
      expect(fixture.expected.input).toBeDefined();
      expect(fixture.expected.messages?.length).toBeGreaterThan(0);
    } else {
      expect(fixture.expected.input).toBeDefined();
    }
  });

  it.each(receiveMessageFixtures)("replays %s through the public Feishu parser", async (name) => {
    const fixture = await loadFixture(name);
    const routed = routeFeishuReceiveMessageEvent(fixture.raw, {
      botIdentity: fixture.botIdentity,
    });

    if (fixture.expected.route === "ignored") {
      expect(routed).toMatchObject({
        route: "ignored",
        ignoredReason: fixture.expected.ignoredReason,
        ...fixture.expected.ignored,
      });
      expect(fixture.expected.logEvents).toContain("chat.message.ignored");
      return;
    }

    expect(routed.route).toBe("accepted");
    if (routed.route !== "accepted") {
      throw new Error(`expected accepted route for ${name}`);
    }
    expect(routed.parsed.route).toBe(fixture.expected.route);
    expect(routed.parsed.input).toMatchObject(fixture.expected.input ?? {});
    expect(fixture.expected.logEvents).toContain("chat.message.accepted");
  });

  it.each(cardActionFixtures)("replays %s through the public Feishu adapter callback path", async (name) => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-card-fixture-"));
    const fixture = await loadFixture(name);
    const wsClient = new FakeWsClient();
    const callbacks: unknown[] = [];
    const expectedValue = readFixtureCardActionValue(fixture.expected.callback);
    configureLogger({
      logDir: path.join(tempRoot, "logs"),
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });

    try {
      const adapter = new FeishuPlatformAdapter({
        appId: "cli-test",
        appSecret: "secret-test",
        api: createHistoryApi({ has_more: false, items: [] }) as never,
        wsClient,
      });

      await adapter.start({
        onMessage: async () => {},
        onInteractive: async (payload) => {
          callbacks.push(payload);
        },
      });

      await wsClient.emit("card.action.trigger", fixture.raw);
      await flushAsyncHandlers();

      expect(callbacks).toHaveLength(1);
      expect(callbacks[0]).toMatchObject(fixture.expected.callback ?? {});
      expect(fixture.expected.logEvents).toContain("chat.card.callback.received");
      await flushLogger();
      const logRecords = await readJsonl(path.join(tempRoot, "logs", "broker.jsonl"));
      expect(logRecords).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: "chat.card.callback.received",
            meta: expect.objectContaining({
              sessionKey: expectedValue.sessionKey,
              conversationId: expectedValue.conversationId,
              rootMessageId: expectedValue.rootMessageId,
              kind: expectedValue.kind,
              candidateRevision: expectedValue.candidateRevision,
            }),
          }),
        ]),
      );
    } finally {
      await flushLogger();
      configureLogger({
        logDir: undefined,
        level: "info",
        rawSlackEvents: false,
        rawFeishuEvents: false,
        rawCodexRpc: false,
        rawHttpRequests: false,
      });
      await fs.rm(tempRoot, {
        recursive: true,
        force: true,
      });
    }
  });

  it("replays history-page through the public Feishu history adapter path", async () => {
    const fixture = await loadFixture("history-page");
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createHistoryApi(fixture.raw) as never,
      wsClient: new FakeWsClient(),
    });

    const messages = await adapter.listThreadMessages({
      platform: "feishu",
      conversationId: "oc_group",
      conversationKind: "group",
      rootMessageId: "om_root",
      platformThreadId: "omt_thread",
      limit: 20,
    });

    expect(messages).toMatchObject(fixture.expected.messages ?? []);
    expect(messages).toEqual(expect.arrayContaining([expect.objectContaining(fixture.expected.input ?? {})]));
    expect(fixture.expected.logEvents).toContain("chat.history.recovered");
  });
});

async function loadFixture(name: string): Promise<FeishuReplayFixture> {
  return JSON.parse(await fs.readFile(fixturePath(name), "utf8")) as FeishuReplayFixture;
}

function fixturePath(name: string): string {
  return path.join(process.cwd(), "test", "fixtures", "feishu", `${name}.json`);
}

function extractRequiredFixtureNames(content: string): string[] {
  const section = content.match(/Required initial fixtures:\n\n(?<table>[\s\S]*?)\n\nFixture rules:/u)?.groups?.table;
  if (!section) {
    throw new Error("Could not find RFC required fixture table");
  }

  const names = [...section.matchAll(/`feishu\/([^`]+)\.json`/gu)].map((match) => match[1]).filter((name): name is string => Boolean(name));
  return [...new Set(names)].sort();
}

function readFixtureCardActionValue(callback: unknown): {
  readonly sessionKey: string;
  readonly conversationId: string;
  readonly rootMessageId: string;
  readonly kind: string;
  readonly candidateRevision: number;
} {
  const action = readRecord(readRecord(callback).action);
  const rawValue = action.value;
  const value = typeof rawValue === "string" ? readRecord(JSON.parse(rawValue) as unknown) : readRecord(rawValue);
  return {
    sessionKey: String(value.sessionKey),
    conversationId: String(value.conversationId),
    rootMessageId: String(value.rootMessageId),
    kind: String(value.kind),
    candidateRevision: Number(value.candidateRevision),
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

class FakeWsClient {
  dispatcher: { invoke: (data: unknown) => Promise<unknown> } | undefined;

  async start(options: { eventDispatcher: { invoke: (data: unknown) => Promise<unknown> } }): Promise<void> {
    this.dispatcher = options.eventDispatcher;
  }

  close(): void {}

  async emit(eventType: string, data: unknown): Promise<void> {
    await this.dispatcher?.invoke({
      schema: "2.0",
      header: {
        event_type: eventType,
      },
      event: data,
    });
  }
}

function flushAsyncHandlers(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function readJsonl(filePath: string): Promise<unknown[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

function createHistoryApi(historyPage: unknown) {
  return {
    listMessages: async () => historyPage,
    replyMessage: async () => ({
      message_id: "om_reply",
    }),
    uploadMessageImage: async () => ({
      image_key: "img_uploaded",
    }),
    uploadMessageFile: async () => ({
      file_key: "file_uploaded",
    }),
    downloadMessageResourceAsDataUrl: async () => "data:text/plain;base64,",
  };
}
