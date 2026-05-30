import fs from "node:fs/promises";

import os from "node:os";

import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";

import { AdminService } from "../src/services/admin-service.js";

import { GitHubAuthorMappingService } from "../src/services/github-author-mapping-service.js";

import { GitHubPrIdentityService } from "../src/services/github-pr-identity-service.js";

import { SessionManager } from "../src/services/session-manager.js";

import { StateStore } from "../src/store/state-store.js";

describe("AdminService", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(
      tempDirs.splice(0).map((directory) =>
        fs.rm(directory, {
          force: true,
          recursive: true,
        }),
      ),
    );
  });

  it("bounds slow runtime status probes so overview can still answer", async () => {
    vi.useFakeTimers();
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-runtime-timeout-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot,
    } as NodeJS.ProcessEnv);
    const never = new Promise<never>(() => {});

    const service = new AdminService({
      config,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      sessions: {
        listSessions: () => [],
        listInboundMessages: () => [],
        listBackgroundJobs: () => [],
      } as never,
      authProfiles: {
        listProfilesStatus: async () => never,
      } as never,
      githubAuthorMappings: {
        load: async () => {},
        listMappings: () => [],
      } as never,
      runtime: {
        readAccountSummary: async () => never,
        readAccountRateLimits: async () => never,
      } as never,
      deployment: {
        getStatus: async () => never,
      } as never,
    });

    const overviewPromise = service.getOverview();
    await vi.advanceTimersByTimeAsync(4_100);
    const overview = await overviewPromise;
    expect(overview).toMatchObject({
      ok: true,
      account: {
        ok: false,
        error: expect.stringContaining("account summary timed out"),
      },
      rateLimits: {
        ok: false,
        error: expect.stringContaining("account rate limits timed out"),
      },
      deployment: {
        ok: false,
        error: expect.stringContaining("deployment status timed out"),
      },
      authProfiles: {
        ok: false,
        error: expect.stringContaining("auth profiles timed out"),
        profiles: [],
      },
    });
  });

  it("keeps overview off the unbounded inbound-message history", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-overview-inbound-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot,
    } as NodeJS.ProcessEnv);
    const inboundCalls: Array<unknown> = [];

    const service = new AdminService({
      config,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      sessions: {
        listSessions: () => [
          {
            key: "C123:111.222",
            channelId: "C123",
            rootThreadTs: "111.222",
            workspacePath: "/tmp/session",
            initiatorUserId: "U0BOB",
            createdAt: "2026-03-19T00:00:00.000Z",
            updatedAt: "2026-03-19T00:00:00.000Z",
          },
        ],
        listInboundMessages: (options?: unknown) => {
          inboundCalls.push(options);
          return [];
        },
        listBackgroundJobs: () => [],
        listAgentTurnUsage: () => {
          throw new Error("overview must not aggregate usage");
        },
      } as never,
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          profiles: [],
        }),
      } as never,
      githubAuthorMappings: {
        load: async () => {},
        listMappings: () => [],
      } as never,
      runtime: {
        readAccountSummary: async () => ({
          account: null,
          requiresOpenaiAuth: true,
        }),
        readAccountRateLimits: async () => ({
          rateLimits: null,
          rateLimitsByLimitId: {},
        }),
      } as never,
    });

    const overview = await service.getOverview();
    expect(overview).not.toHaveProperty("usage");
    expect(overview).toMatchObject({
      state: {
        sessionCount: 1,
        openInboundCount: 0,
      },
      githubAccounts: {
        accounts: [
          {
            slackUserId: "U0BOB",
          },
        ],
      },
    });
    expect(inboundCalls).toEqual([]);
  });

  it("resolves session Slack thread links through Slack permalinks", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-thread-link-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot,
    } as NodeJS.ProcessEnv);

    await fs.mkdir(config.codexHome, { recursive: true });
    await fs.mkdir(config.logDir, { recursive: true });

    const stateStore = new StateStore(config.stateDir, config.sessionsRoot);
    const sessions = new SessionManager({
      stateStore,
      sessionsRoot: config.sessionsRoot,
    });
    await sessions.load();
    await sessions.ensureSession("C123", "111.222");

    const permalinkCalls: Array<Record<string, string>> = [];
    const service = new AdminService({
      config,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      sessions,
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          profiles: [],
        }),
      } as never,
      githubAuthorMappings: {
        load: async () => {},
        listMappings: () => [],
      } as never,
      runtime: {
        restartRuntime: async () => {},
        readAccountSummary: async () => ({
          account: null,
          requiresOpenaiAuth: true,
        }),
        readAccountRateLimits: async () => ({
          rateLimits: null,
          rateLimitsByLimitId: {},
        }),
      } as never,
      slackConversations: {
        getConversationInfo: async () => null,
        getPermalink: async (options) => {
          permalinkCalls.push(options);
          return "https://workspace.slack.com/archives/C123/p111222?thread_ts=111.222&cid=C123";
        },
      },
    });

    await expect(service.getSessionSlackThreadUrl("C123:111.222")).resolves.toEqual({
      ok: true,
      sessionKey: "C123:111.222",
      url: "https://workspace.slack.com/archives/C123/p111222?thread_ts=111.222&cid=C123",
    });
    expect(permalinkCalls).toEqual([{ channelId: "C123", messageTs: "111.222" }]);
  });

  it("exposes Feishu sessions without Slack-only thread links", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-feishu-session-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot,
    } as NodeJS.ProcessEnv);

    await fs.mkdir(config.codexHome, { recursive: true });
    await fs.mkdir(config.logDir, { recursive: true });

    const stateStore = new StateStore(config.stateDir, config.sessionsRoot);
    const sessions = new SessionManager({
      stateStore,
      sessionsRoot: config.sessionsRoot,
    });
    await sessions.load();
    const feishuSession = await sessions.ensureChatSession(
      {
        platform: "feishu",
        conversationId: "oc_group",
        rootMessageId: "om_root",
      },
      {
        conversationKind: "group",
        platformThreadId: "om_root",
      },
    );

    const permalinkCalls: Array<Record<string, string>> = [];
    const service = new AdminService({
      config,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      sessions,
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          profiles: [],
        }),
      } as never,
      githubAuthorMappings: {
        load: async () => {},
        listMappings: () => [],
      } as never,
      runtime: {
        restartRuntime: async () => {},
        readAccountSummary: async () => ({
          account: null,
          requiresOpenaiAuth: true,
        }),
        readAccountRateLimits: async () => ({
          rateLimits: null,
          rateLimitsByLimitId: {},
        }),
      } as never,
      slackConversations: {
        getConversationInfo: async () => null,
        getPermalink: async (options) => {
          permalinkCalls.push(options);
          return "https://workspace.slack.com/archives/C123/p111222";
        },
      },
    });

    const summaries = (await service.listSessionSummaries()) as Record<string, any>;
    expect(summaries.sessions).toEqual([
      expect.objectContaining({
        key: feishuSession.key,
        platform: "feishu",
        conversationId: "oc_group",
        conversationKind: "group",
        rootMessageId: "om_root",
        platformThreadId: "om_root",
        channelId: "oc_group",
        rootThreadTs: "om_root",
        threadUrl: null,
      }),
    ]);
    await expect(service.getSessionSlackThreadUrl(feishuSession.key)).resolves.toMatchObject({
      ok: false,
      error: "platform_permalink_unavailable",
      platform: "feishu",
      sessionKey: feishuSession.key,
    });
    expect(permalinkCalls).toEqual([]);
  });

  it("exposes GitHub author mappings and OAuth bindings as unified GitHub accounts", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-github-accounts-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot,
      BROKER_DEFAULT_GITHUB_LOGIN: "legacy-bot",
      BROKER_DEFAULT_GITHUB_TOKEN: "legacy-token",
    } as NodeJS.ProcessEnv);

    const githubAuthorMappings = new GitHubAuthorMappingService({ stateDir: config.stateDir });
    await githubAuthorMappings.load();
    await githubAuthorMappings.upsertManualMapping({
      slackUserId: "U_ALICE",
      githubAuthor: "Alice Example <alice@example.com>",
      slackIdentity: {
        userId: "U_ALICE",
        mention: "<@U_ALICE>",
        displayName: "Alice",
        email: "alice@example.com",
      },
    });

    const githubPrIdentity = new GitHubPrIdentityService({
      stateDir: config.stateDir,
      defaultGitHubLogin: config.defaultGitHubLogin,
      defaultGitHubToken: config.defaultGitHubToken,
    });
    await githubPrIdentity.load();
    await githubPrIdentity.upsertBinding({
      slackUserId: "U_ALICE",
      githubLogin: "alice-gh",
      githubUserId: 101,
      token: "alice-token",
      scopes: ["repo", "read:user", "user:email"],
      githubEmail: "alice@github.example",
      githubName: "Alice GitHub",
    });
    await githubPrIdentity.setDefaultBinding("U_ALICE");

    const service = new AdminService({
      config,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      sessions: {
        listSessions: () => [
          {
            key: "C123:111.222",
            channelId: "C123",
            rootThreadTs: "111.222",
            workspacePath: "/tmp/session",
            initiatorUserId: "U0BOB",
            createdAt: "2026-03-19T00:00:00.000Z",
            updatedAt: "2026-03-19T00:00:00.000Z",
          },
        ],
        listInboundMessages: () => [
          {
            key: "m1",
            sessionKey: "C123:111.222",
            channelId: "C123",
            rootThreadTs: "111.222",
            messageTs: "111.222",
            source: "app_mention",
            userId: "U0BOB",
            text: "@bot hi",
            senderKind: "user",
            senderUsername: "bob",
            mentionedUsers: [],
            status: "done",
            createdAt: "2026-03-19T00:00:00.000Z",
            updatedAt: "2026-03-19T00:00:00.000Z",
          },
          {
            key: "m2",
            sessionKey: "C123:111.222",
            channelId: "C123",
            rootThreadTs: "111.222",
            messageTs: "111.333",
            source: "thread_reply",
            userId: "U_CAROL",
            text: "please review this too",
            senderKind: "user",
            senderUsername: "carol",
            mentionedUsers: [],
            status: "done",
            createdAt: "2026-03-19T00:00:00.000Z",
            updatedAt: "2026-03-19T00:00:00.000Z",
          },
          {
            key: "m3",
            sessionKey: "C123:111.222",
            channelId: "C123",
            rootThreadTs: "111.222",
            messageTs: "111.444",
            source: "thread_reply",
            userId: "U_BOT",
            text: "bot message",
            senderKind: "bot",
            mentionedUsers: [],
            status: "done",
            createdAt: "2026-03-19T00:00:00.000Z",
            updatedAt: "2026-03-19T00:00:00.000Z",
          },
          {
            key: "m4",
            sessionKey: "C123:111.222",
            channelId: "C123",
            rootThreadTs: "111.222",
            messageTs: "111.555",
            source: "thread_reply",
            userId: "username:legacy-bot",
            text: "legacy sender",
            senderKind: "user",
            mentionedUsers: [],
            status: "done",
            createdAt: "2026-03-19T00:00:00.000Z",
            updatedAt: "2026-03-19T00:00:00.000Z",
          },
        ],
        listBackgroundJobs: () => [],
      } as never,
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          profiles: [],
        }),
      } as never,
      githubAuthorMappings,
      githubPrIdentity,
      slackConversations: {
        getUserIdentity: async (userId: string) => {
          if (userId !== "U0BOB") return null;
          return {
            userId,
            mention: `<@${userId}>`,
            username: "bob",
            displayName: "Bob Slack",
            realName: "Bob Example",
            email: "bob@example.com",
          };
        },
      } as never,
      runtime: {
        readAccountSummary: async () => ({
          account: null,
          requiresOpenaiAuth: true,
        }),
        readAccountRateLimits: async () => ({
          rateLimits: null,
          rateLimitsByLimitId: {},
        }),
      } as never,
    });

    const overview = await service.getOverview();
    expect(overview.githubAccounts).toMatchObject({
      count: 2,
      defaultPrAccount: {
        available: true,
        source: "bound",
        slackUserId: "U_ALICE",
        githubLogin: "alice-gh",
      },
      accounts: [
        {
          slackUserId: "U_ALICE",
          isDefaultPrAccount: true,
          slackIdentity: {
            userId: "U_ALICE",
            mention: "<@U_ALICE>",
          },
          prBinding: {
            state: "bound",
            githubLogin: "alice-gh",
            githubUserId: 101,
            githubEmail: "alice@github.example",
            githubName: "Alice GitHub",
            scopes: ["repo", "read:user", "user:email"],
          },
        },
        {
          slackUserId: "U0BOB",
          slackIdentity: {
            userId: "U0BOB",
            mention: "<@U0BOB>",
            username: "bob",
            displayName: "Bob Slack",
            realName: "Bob Example",
            email: "bob@example.com",
          },
          prBinding: {
            state: "unbound",
          },
        },
      ],
    });
    expect(JSON.stringify(overview.githubAccounts)).not.toContain("U_CAROL");
    expect(JSON.stringify(overview.githubAccounts)).not.toContain("U_BOT");
    expect(JSON.stringify(overview.githubAccounts)).not.toContain("username:legacy-bot");
    expect(JSON.stringify(overview.githubAccounts)).not.toContain("githubAuthor");
    expect(JSON.stringify(overview.githubAccounts)).not.toContain("Alice Example <alice@example.com>");
  });
});
