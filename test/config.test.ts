import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("throws when required variables are missing", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrowError(
      "Missing required environment variable: SLACK_APP_TOKEN"
    );
  });

  it("loads required configuration", () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    } as NodeJS.ProcessEnv);

    expect(config.slackAppToken).toBe("xapp-test");
    expect(config.slackBotToken).toBe("xoxb-test");
    expect(config.stateDir.endsWith(".data/state")).toBe(true);
    expect(config.sessionsRoot.endsWith(".data/sessions")).toBe(true);
    expect(config.reposRoot.endsWith(".data/repos")).toBe(true);
    expect(config.logDir.endsWith(".data/logs")).toBe(true);
    expect(config.codexHostHomePath).toBeUndefined();
    expect(config.slackInitialThreadHistoryCount).toBe(8);
    expect(config.slackHistoryApiMaxLimit).toBe(50);
    expect(config.slackActiveTurnReconcileIntervalMs).toBe(15_000);
    expect(config.slackProgressReminderAfterMs).toBe(120_000);
    expect(config.slackProgressReminderRepeatMs).toBe(120_000);
    expect(config.feishuEnabled).toBe(false);
    expect(config.feishuAppId).toBeUndefined();
    expect(config.feishuAppSecret).toBeUndefined();
    expect(config.feishuBotOpenId).toBeUndefined();
    expect(config.feishuBotUserId).toBeUndefined();
    expect(config.feishuBotUnionId).toBeUndefined();
    expect(config.feishuApiBaseUrl).toBe("https://open.feishu.cn/open-apis");
    expect(config.feishuDomain).toBe("feishu");
    expect(config.feishuInitialThreadHistoryCount).toBe(8);
    expect(config.feishuHistoryApiMaxLimit).toBe(50);
    expect(config.feishuGroupMessageMode).toBe("all");
    expect(config.feishuAllMessageDeliveryVerified).toBe(false);
    expect(config.feishuStartupRequired).toBe(true);
    expect(config.logLevel).toBe("info");
    expect(config.logRawSlackEvents).toBe(true);
    expect(config.logRawFeishuEvents).toBe(false);
    expect(config.logRawCodexRpc).toBe(true);
    expect(config.logRawHttpRequests).toBe(true);
    expect(config.brokerAdminToken).toBeUndefined();
    expect(config.geminiHostHomePath).toBeUndefined();
    expect(config.geminiHttpProxy).toBeUndefined();
    expect(config.geminiHttpsProxy).toBeUndefined();
    expect(config.geminiAllProxy).toBeUndefined();
    expect(config.isolatedMcpServers).toEqual(["linear", "notion"]);
    expect(config.codexDisabledMcpServers).toEqual(["*", "linear", "notion"]);
    expect(config.tempadLinkServiceUrl).toBeUndefined();
  });

  it("rejects invalid numeric values", () => {
    expect(() =>
      loadConfig({
        SLACK_APP_TOKEN: "xapp-test",
        SLACK_BOT_TOKEN: "xoxb-test",
        PORT: "nope"
      } as NodeJS.ProcessEnv)
    ).toThrowError("Invalid numeric environment variable: PORT");
  });

  it("requires Feishu credentials only when Feishu is enabled", () => {
    expect(() =>
      loadConfig({
        SLACK_APP_TOKEN: "xapp-test",
        SLACK_BOT_TOKEN: "xoxb-test",
        FEISHU_ENABLED: "true",
        FEISHU_APP_ID: "cli-test"
      } as NodeJS.ProcessEnv)
    ).toThrowError("Missing required environment variable: FEISHU_APP_SECRET");

    expect(() =>
      loadConfig({
        SLACK_APP_TOKEN: "xapp-test",
        SLACK_BOT_TOKEN: "xoxb-test",
        FEISHU_ENABLED: "true",
        FEISHU_APP_ID: "cli-test",
        FEISHU_APP_SECRET: "secret-test"
      } as NodeJS.ProcessEnv)
    ).toThrowError(
      "Missing required environment variable: one of FEISHU_BOT_OPEN_ID, FEISHU_BOT_USER_ID, FEISHU_BOT_UNION_ID"
    );
  });

  it("loads China Feishu configuration", () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      FEISHU_ENABLED: "true",
      FEISHU_APP_ID: "cli-test",
      FEISHU_APP_SECRET: "secret-test",
      FEISHU_BOT_OPEN_ID: "ou_bot",
      FEISHU_INITIAL_THREAD_HISTORY_COUNT: "12",
      FEISHU_HISTORY_API_MAX_LIMIT: "40",
      FEISHU_GROUP_MESSAGE_MODE: "at_only",
      FEISHU_ALL_MESSAGE_DELIVERY_VERIFIED: "true",
      FEISHU_STARTUP_REQUIRED: "false"
    } as NodeJS.ProcessEnv);

    expect(config.feishuEnabled).toBe(true);
    expect(config.feishuAppId).toBe("cli-test");
    expect(config.feishuAppSecret).toBe("secret-test");
    expect(config.feishuBotOpenId).toBe("ou_bot");
    expect(config.feishuBotUserId).toBeUndefined();
    expect(config.feishuBotUnionId).toBeUndefined();
    expect(config.feishuDomain).toBe("feishu");
    expect(config.feishuInitialThreadHistoryCount).toBe(12);
    expect(config.feishuHistoryApiMaxLimit).toBe(40);
    expect(config.feishuGroupMessageMode).toBe("at_only");
    expect(config.feishuAllMessageDeliveryVerified).toBe(true);
    expect(config.feishuStartupRequired).toBe(false);
  });

  it("rejects non-China Feishu domains for the first implementation", () => {
    expect(() =>
      loadConfig({
        SLACK_APP_TOKEN: "xapp-test",
        SLACK_BOT_TOKEN: "xoxb-test",
        FEISHU_DOMAIN: "lark"
      } as NodeJS.ProcessEnv)
    ).toThrowError("Invalid FEISHU_DOMAIN: expected feishu");
  });

  it("validates Feishu API base URL shape", () => {
    const baseEnv = {
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    };

    expect(loadConfig({
      ...baseEnv,
      FEISHU_API_BASE_URL: "https://open.feishu.cn/"
    } as NodeJS.ProcessEnv).feishuApiBaseUrl).toBe("https://open.feishu.cn");

    expect(() =>
      loadConfig({
        ...baseEnv,
        FEISHU_API_BASE_URL: "https://open.feishu.cn/open-apis/im/v1"
      } as NodeJS.ProcessEnv)
    ).toThrowError("Invalid FEISHU_API_BASE_URL: expected origin or /open-apis path");

    expect(() =>
      loadConfig({
        ...baseEnv,
        FEISHU_API_BASE_URL: "https://open.larksuite.com/open-apis"
      } as NodeJS.ProcessEnv)
    ).toThrowError("Invalid FEISHU_API_BASE_URL: expected https://open.feishu.cn");

    expect(() =>
      loadConfig({
        ...baseEnv,
        FEISHU_API_BASE_URL: "not-a-url"
      } as NodeJS.ProcessEnv)
    ).toThrowError("Invalid FEISHU_API_BASE_URL: expected an absolute URL");
  });

  it("loads an explicit host codex home path", () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      CODEX_HOST_HOME_PATH: "/host-codex-home"
    } as NodeJS.ProcessEnv);

    expect(config.codexHostHomePath).toBe("/host-codex-home");
  });

  it("loads Gemini runtime configuration", () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      GEMINI_HOST_HOME_PATH: "/host-gemini-home",
      GEMINI_HTTP_PROXY: "http://host.docker.internal:6152",
      GEMINI_HTTPS_PROXY: "http://host.docker.internal:6152",
      GEMINI_ALL_PROXY: "socks5://host.docker.internal:6153"
    } as NodeJS.ProcessEnv);

    expect(config.geminiHostHomePath).toBe("/host-gemini-home");
    expect(config.geminiHttpProxy).toBe("http://host.docker.internal:6152");
    expect(config.geminiHttpsProxy).toBe("http://host.docker.internal:6152");
    expect(config.geminiAllProxy).toBe("socks5://host.docker.internal:6153");
  });

  it("loads an explicit tempad link service url override", () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      TEMPAD_LINK_SERVICE_URL: "http://host.docker.internal:4320"
    } as NodeJS.ProcessEnv);

    expect(config.tempadLinkServiceUrl).toBe("http://host.docker.internal:4320");
  });

  it("parses disabled MCP servers as a csv list and unions isolated MCP servers", () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      CODEX_DISABLED_MCP_SERVERS: " github, linear ,, ",
      ISOLATED_MCP_SERVERS: " notion, linear ,, "
    } as NodeJS.ProcessEnv);

    expect(config.isolatedMcpServers).toEqual(["notion", "linear"]);
    expect(config.codexDisabledMcpServers).toEqual(["*", "github", "linear", "notion"]);
  });

  it("parses log configuration", () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      LOG_LEVEL: "debug",
      LOG_RAW_SLACK_EVENTS: "false",
      LOG_RAW_FEISHU_EVENTS: "true",
      LOG_RAW_CODEX_RPC: "false",
      LOG_RAW_HTTP_REQUESTS: "true"
    } as NodeJS.ProcessEnv);

    expect(config.logLevel).toBe("debug");
    expect(config.logRawSlackEvents).toBe(false);
    expect(config.logRawFeishuEvents).toBe(true);
    expect(config.logRawCodexRpc).toBe(false);
    expect(config.logRawHttpRequests).toBe(true);
  });

  it("loads an optional broker admin token", () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      BROKER_ADMIN_TOKEN: "secret-admin-token"
    } as NodeJS.ProcessEnv);

    expect(config.brokerAdminToken).toBe("secret-admin-token");
  });
});
