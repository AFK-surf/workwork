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

  it("reports session activity time from real activity instead of metadata updates", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-activity-time-"));
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
    await sessions.ensureSession("C123", "222.333");
    await sessions.upsertInboundMessage({
      key: "C123:111.222:111.223",
      sessionKey: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      messageTs: "111.223",
      source: "thread_reply",
      userId: "U123",
      text: "old activity",
      status: "done",
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:00.000Z",
    });
    await sessions.upsertInboundMessage({
      key: "C123:222.333:222.334",
      sessionKey: "C123:222.333",
      channelId: "C123",
      rootThreadTs: "222.333",
      messageTs: "222.334",
      source: "thread_reply",
      userId: "U123",
      text: "new activity",
      status: "done",
      createdAt: "2026-03-20T00:00:00.000Z",
      updatedAt: "2026-03-20T00:00:00.000Z",
    });

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
    });

    const status = await service.getStatus();
    const summaries = (status as Record<string, any>).state.sessions as Record<string, any>[];
    expect(summaries.map((session) => session.key).slice(0, 2)).toEqual(["C123:222.333", "C123:111.222"]);
    expect(summaries.find((session) => session.key === "C123:111.222")).toMatchObject({
      updatedAt: expect.any(String),
      lastActivityAt: "2026-03-19T00:00:00.000Z",
    });
  });

  it("splits open inbound counts into human and system messages", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-open-inbound-"));
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
    await sessions.upsertInboundMessage({
      key: "C123:111.222:111.223",
      sessionKey: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      messageTs: "111.223",
      source: "thread_reply",
      userId: "U123",
      text: "follow up",
      status: "pending",
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:00.000Z",
    });
    await sessions.upsertInboundMessage({
      key: "C123:111.222:111.224",
      sessionKey: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      messageTs: "111.224",
      source: "background_job_event",
      userId: "U0ALY77RMJL",
      text: "job update",
      status: "pending",
      createdAt: "2026-03-19T00:00:01.000Z",
      updatedAt: "2026-03-19T00:00:01.000Z",
    });

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
          account: {
            email: "quota@example.com",
            type: "chatgpt",
            planType: "team",
          },
          requiresOpenaiAuth: false,
        }),
        readAccountRateLimits: async () => ({
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            primary: {
              usedPercent: 42,
              windowDurationMins: 300,
              resetsAt: 1_735_692_000,
            },
            secondary: null,
            credits: null,
            planType: "team",
          },
          rateLimitsByLimitId: {},
        }),
      } as never,
    });

    const status = await service.getStatus();
    expect(status).toMatchObject({
      state: {
        openInboundCount: 2,
        openHumanInboundCount: 1,
        openSystemInboundCount: 1,
        sessions: [
          {
            openInboundCount: 2,
            openHumanInboundCount: 1,
            openSystemInboundCount: 1,
          },
        ],
      },
    });
  });
});
